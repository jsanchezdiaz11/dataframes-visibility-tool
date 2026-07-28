const { readdir, readFile, stat } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8000);
const ROOT = path.join(__dirname);
const INPUT_DIR = path.join(ROOT, 'input');
const POLARS_TYPES_ROOT = path.join(ROOT, 'node_modules', 'nodejs-polars', 'bin');
const QUERY_TIMEOUT_MS = 5_000;
const QUERY_ROW_LIMIT = 500;
const MAX_REQUEST_BYTES = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

let queryRunning = false;
let polarsTypeFilesPromise;

const dataframeAliasBase = filename => {
  const base = path.basename(filename, '.csv').replace(/[^a-zA-Z0-9_$]/g, '_');
  return /^[a-zA-Z_$]/.test(base) ? base : `dataframe_${base}`;
};

const uniqueDataframeAlias = (filename, usedAliases) => {
  const base = dataframeAliasBase(filename);
  let alias = base;
  let suffix = 2;
  while (usedAliases.has(alias)) {
    alias = `${base}_${suffix}`;
    suffix += 1;
  }
  usedAliases.add(alias);
  return alias;
};

const csvFiles = async () => {
  const entries = await readdir(INPUT_DIR, { withFileTypes: true });
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.csv'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const usedAliases = new Set();
  return filenames.map(name => ({ name, alias: uniqueDataframeAlias(name, usedAliases) }));
};

const polarsTypeFiles = () => {
  polarsTypeFilesPromise ??= readdir(POLARS_TYPES_ROOT, { recursive: true }).then(relativePaths =>
    relativePaths
      .filter(relativePath => relativePath.endsWith('.d.ts'))
      .sort((left, right) => left.localeCompare(right))
      .reduce(
        async (filesPromise, relativePath) => [
          ...(await filesPromise),
          {
            path: relativePath.split(path.sep).join('/'),
            content: await readFile(path.join(POLARS_TYPES_ROOT, relativePath), 'utf8'),
          },
        ],
        Promise.resolve([]),
      ),
  );
  return polarsTypeFilesPromise;
};

const send = (response, status, contentType, body) => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
};

const sendJson = (response, status, value) =>
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));

const readRequestBody = request =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const safeCsvPath = async filename => {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    return null;
  }
  const filePath = path.join(INPUT_DIR, filename);
  if (!filename.endsWith('.csv') || path.dirname(filePath) !== INPUT_DIR) {
    return null;
  }
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? filePath : null;
  } catch {
    return null;
  }
};

const runQuery = ({ code, files }) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(path.join(ROOT, 'query-worker.js'), {
      workerData: { code, files, rowLimit: QUERY_ROW_LIMIT },
    });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Query exceeded the ${QUERY_TIMEOUT_MS / 1_000}-second limit.`));
    }, QUERY_TIMEOUT_MS);

    worker.once('message', result => {
      clearTimeout(timeout);
      worker.terminate();
      if (result.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result);
    });
    worker.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const serveStaticFile = async (response, pathname) => {
  const csvFilename = pathname.startsWith('/') ? decodeURIComponent(pathname.slice(1)) : '';
  const staticFilename = STATIC_FILES.get(pathname);
  const filePath = staticFilename
    ? path.join(ROOT, staticFilename)
    : await safeCsvPath(csvFilename);
  if (!filePath) {
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  const extension = path.extname(filePath);
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  send(
    response,
    200,
    contentTypes[extension] ?? 'application/octet-stream',
    await readFile(filePath),
  );
};

const handleQuery = async (request, response) => {
  const origin = request.headers.origin;
  const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: 'Query requests must come from the local viewer.' });
    return;
  }
  if (request.headers['content-type'] !== 'application/json') {
    sendJson(response, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  let ownsQuerySlot = false;
  try {
    const body = JSON.parse(await readRequestBody(request));
    if (typeof body.code !== 'string' || body.code.trim() === '') {
      throw new Error('Query code is required.');
    }
    if (!Array.isArray(body.dataframes) || body.dataframes.length === 0) {
      throw new Error('Select at least one DataFrame.');
    }
    if (queryRunning) {
      sendJson(response, 409, { error: 'Another query is already running.' });
      return;
    }
    queryRunning = true;
    ownsQuerySlot = true;

    const availableFiles = await csvFiles();
    const selectedFiles = body.dataframes.map(filename => {
      const dataframe = availableFiles.find(file => file.name === filename);
      if (!dataframe) {
        throw new Error(`Unknown DataFrame: ${filename}`);
      }
      return { ...dataframe, path: path.join(INPUT_DIR, dataframe.name) };
    });

    const result = await runQuery({ code: body.code, files: selectedFiles });
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : 'Unable to execute query.',
    });
  } finally {
    if (ownsQuerySlot) {
      queryRunning = false;
    }
  }
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/api/csv-files') {
      sendJson(response, 200, { files: await csvFiles() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/polars-types') {
      sendJson(response, 200, { files: await polarsTypeFiles() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/query') {
      await handleQuery(request, response);
      return;
    }
    if (request.method === 'GET') {
      await serveStaticFile(response, url.pathname);
      return;
    }
    send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DataFrame viewer running at http://${HOST}:${PORT}`);
  console.log('Warning: Polars queries execute trusted local JavaScript.');
});
