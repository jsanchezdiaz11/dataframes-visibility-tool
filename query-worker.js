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
  if (isLazyDataFrame(result)) {
    plan = result.describePlan();
    optimizedPlan = result.describeOptimizedPlan();
    dataFrame = await result.limit(workerData.rowLimit + 1).collect();
  } else if (isDataFrame(result)) {
    dataFrame = result;
  } else {
    throw new Error('The query must return a Polars DataFrame or LazyDataFrame.');
  }

  const allRows = dataFrame.toRecords();
  const truncated = allRows.length > workerData.rowLimit;
  const rows = allRows.slice(0, workerData.rowLimit).map(serializeValue);
  parentPort.postMessage({
    columns: dataFrame.columns,
    columnTypes: dataFrame.dtypes.map(dtype => dtype.constructor?.name ?? String(dtype)),
    rows,
    rowCount: rows.length,
    truncated,
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
