const { parentPort, workerData } = require('node:worker_threads');
const pl = require('nodejs-polars');

const serializeValue = value => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, serializeValue(nestedValue)]),
    );
  }
  return value;
};

const isLazyDataFrame = value =>
  value &&
  typeof value.collect === 'function' &&
  typeof value.describePlan === 'function' &&
  typeof value.describeOptimizedPlan === 'function';

const isDataFrame = value => value && typeof value.toRecords === 'function';

const scanDataframe = ({ path, kind }) => {
  switch (kind) {
    case 'csv':
      return pl.scanCSV(path);
    case 'parquet':
      return pl.scanParquet(path);
    case 'ipc':
      return pl.scanIPC(path);
    default:
      throw new Error(`Unsupported DataFrame format: ${kind ?? 'unknown'}`);
  }
};

const run = async () => {
  const frames = Object.fromEntries(
    workerData.files.map(file => [file.alias, scanDataframe(file)]),
  );

  const AsyncFunction = Object.getPrototypeOf(run).constructor;
  const queryExpression = workerData.code.trim().replace(/;$/, '');
  
  const execute = new AsyncFunction('pl', 'frames', `"use strict"; ${queryExpression}`);
  const startedAt = performance.now();
  const result = await execute(pl, frames);

  let dataFrame;
  let plan = '';
  let optimizedPlan = '';
  let totalRows = 0;
  const page = Math.max(1, Number(workerData.page ?? 1));
  const pageSize = Math.max(1, Number(workerData.pageSize ?? 200));
  const offset = (page - 1) * pageSize;

  if (isLazyDataFrame(result)) {
    plan = result.describePlan();
    optimizedPlan = result.describeOptimizedPlan();
    const countFrame = await result.select(pl.len()).collect();
    const countRecord = countFrame.toRecords()[0] ?? {};
    totalRows = Number(countRecord?.len ?? countRecord?.[0] ?? 0);
    dataFrame = await result.slice(offset, pageSize).collect();
  } else if (isDataFrame(result)) {
    dataFrame = result;
    totalRows = Number(dataFrame.height ?? dataFrame.shape?.[0] ?? 0);
  } else {
    throw new Error('The query must return a Polars DataFrame or LazyDataFrame.');
  }

  const pageDataFrame = isLazyDataFrame(result) ? dataFrame : dataFrame.slice(offset, pageSize);
  const rows = pageDataFrame.toRecords().map(serializeValue);
  parentPort.postMessage({
    columns: dataFrame.columns,
    columnTypes: dataFrame.dtypes.map(dtype => dtype.constructor?.name ?? String(dtype)),
    rows,
    rowCount: rows.length,
    totalRows,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
    hasPreviousPage: page > 1,
    hasNextPage: page * pageSize < totalRows,
    truncated: false,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    plan,
    optimizedPlan,
  });
};

run().catch(error => {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : 'Unknown query execution error',
  });
});
