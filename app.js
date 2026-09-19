const elements = {
  tabs: [...document.querySelectorAll('.tab')],
  panels: [...document.querySelectorAll('.panel')],
  leftDataset: document.querySelector('#left-dataset'),
  rightDataset: document.querySelector('#right-dataset'),
  leftMatchColumn: document.querySelector('#left-match-column'),
  rightMatchColumn: document.querySelector('#right-match-column'),
  search: document.querySelector('#search'),
  dataframeUpload: document.querySelector('#dataframe-upload'),
  uploadStatus: document.querySelector('#upload-status'),
  differencesOnly: document.querySelector('#differences-only'),
  comparePageSize: document.querySelector('#compare-page-size'),
  comparePrevPage: document.querySelector('#compare-prev-page'),
  compareNextPage: document.querySelector('#compare-next-page'),
  comparePageIndicator: document.querySelector('#compare-page-indicator'),
  comparePaginationControls: document.querySelector('#compare-pagination-controls'),
  comparisonStatus: document.querySelector('#comparison-status'),
  columnPickers: [...document.querySelectorAll('.column-picker')],
  left: {
    title: document.querySelector('#left-title'),
    container: document.querySelector('#left-container'),
    head: document.querySelector('#left-head'),
    body: document.querySelector('#left-body'),
    empty: document.querySelector('#left-empty'),
    columnSummary: document.querySelector('#left-column-summary'),
    columnOptions: document.querySelector('#left-column-options'),
    showAllColumns: document.querySelector('#left-show-all-columns'),
  },
  right: {
    title: document.querySelector('#right-title'),
    container: document.querySelector('#right-container'),
    head: document.querySelector('#right-head'),
    body: document.querySelector('#right-body'),
    empty: document.querySelector('#right-empty'),
    columnSummary: document.querySelector('#right-column-summary'),
    columnOptions: document.querySelector('#right-column-options'),
    showAllColumns: document.querySelector('#right-show-all-columns'),
  },
  queryDataframes: document.querySelector('#query-dataframes'),
  queryTabsList: document.querySelector('#query-tabs-list'),
  newQueryTab: document.querySelector('#new-query-tab'),
  queryEditor: document.querySelector('#query-editor'),
  queryEditorFallback: document.querySelector('#query-editor-fallback'),
  runQuery: document.querySelector('#run-query'),
  queryStatus: document.querySelector('#query-status'),
  queryOutput: document.querySelector('#query-output'),
  queryMetadata: document.querySelector('#query-metadata'),
  queryPageSize: document.querySelector('#query-page-size'),
  queryPrevPage: document.querySelector('#query-prev-page'),
  queryNextPage: document.querySelector('#query-next-page'),
  queryPageIndicator: document.querySelector('#query-page-indicator'),
  queryPaginationControls: document.querySelector('#query-pagination-controls'),
  queryHead: document.querySelector('#query-head'),
  queryBody: document.querySelector('#query-body'),
  queryPlan: document.querySelector('#query-plan'),
  queryOptimizedPlan: document.querySelector('#query-optimized-plan'),
};

const MONACO_BASE_URL = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs';

const describeDataframeFile = file => {
  const filename = file.name ?? file.filename ?? 'unknown';
  const metadataLabel = file.metadataLabel ? ` · ${file.metadataLabel}` : '';
  return `${filename} · ${file.label}${metadataLabel}`;
};

let availableFiles = [];
let frames = {
  left: { filename: '', columns: [], columnTypes: [], rows: [] },
  right: { filename: '', columns: [], columnTypes: [], rows: [] },
};
let sort = { side: '', column: '', direction: 'ascending' };
let visibleColumns = { left: new Set(), right: new Set() };
let monacoApi;
let monacoEditor;
let frameTypesDisposable;
let comparePage = 1;
let queryTabs = [];
let activeQueryTabId = '';
let nextQueryTabId = 1;
const QUERY_TABS_STORAGE_KEY = 'dataframe-debug-query-tabs';

const activeQueryTab = () => queryTabs.find(tab => tab.id === activeQueryTabId);

const queryCode = () =>
  monacoEditor ? monacoEditor.getValue() : elements.queryEditorFallback.value;

const setQueryCode = code => {
  if (monacoEditor) {
    monacoEditor.setValue(code);
    return;
  }
  elements.queryEditorFallback.value = code;
};

const saveActiveQueryTab = () => {
  const tab = activeQueryTab();
  if (!tab) return;
  tab.code = queryCode();
  tab.dataframes = selectedQueryDataframes();
  tab.pageSize = Number(elements.queryPageSize?.value ?? 200);
  persistQueryTabs();
};

const persistQueryTabs = () => {
  sessionStorage.setItem(
    QUERY_TABS_STORAGE_KEY,
    JSON.stringify({
      activeQueryTabId,
      tabs: queryTabs.map(({ id, name, code, dataframes, page, pageSize }) => ({
        id,
        name,
        code,
        dataframes,
        page,
        pageSize,
      })),
    }),
  );
};

const renameQueryTab = tab => {
  const name = window.prompt('Tab name', tab.name);
  if (name === null) return;
  const trimmedName = name.trim();
  if (!trimmedName) return;
  tab.name = trimmedName;
  persistQueryTabs();
  renderQueryTabs();
};

const closeQueryTab = id => {
  const tabIndex = queryTabs.findIndex(tab => tab.id === id);
  if (tabIndex < 0) return;
  const wasActive = id === activeQueryTabId;
  if (wasActive) saveActiveQueryTab();
  queryTabs.splice(tabIndex, 1);
  if (queryTabs.length === 0) {
    createQueryTab();
    return;
  }
  if (wasActive) {
    const nextTab = queryTabs[Math.min(tabIndex, queryTabs.length - 1)];
    activeQueryTabId = nextTab.id;
    activateQueryTab(nextTab.id);
    return;
  }
  persistQueryTabs();
  renderQueryTabs();
};

const renderQueryTabs = () => {
  elements.queryTabsList.replaceChildren();
  queryTabs.forEach(tab => {
    const tabItem = document.createElement('div');
    const button = document.createElement('button');
    const closeButton = document.createElement('button');
    tabItem.className = 'query-tab-item';
    button.type = 'button';
    button.className = 'query-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === activeQueryTabId));
    button.textContent = tab.name;
    button.title = 'Double-click to rename';
    button.addEventListener('click', () => activateQueryTab(tab.id));
    button.addEventListener('dblclick', () => renameQueryTab(tab));
    closeButton.type = 'button';
    closeButton.className = 'query-tab-close';
    closeButton.setAttribute('aria-label', `Close ${tab.name}`);
    closeButton.title = `Close ${tab.name}`;
    closeButton.textContent = '×';
    closeButton.addEventListener('click', event => {
      event.stopPropagation();
      closeQueryTab(tab.id);
    });
    tabItem.append(button, closeButton);
    elements.queryTabsList.append(tabItem);
  });
};

const createQueryTab = (code = '') => {
  const tab = {
    id: `query-${nextQueryTabId++}`,
    name: `Query ${queryTabs.length + 1}`,
    code,
    dataframes: availableFiles.map(file => file.name),
    page: 1,
    pageSize: 200,
    result: null,
  };
  queryTabs.push(tab);
  persistQueryTabs();
  activateQueryTab(tab.id);
};

const activateQueryTab = id => {
  saveActiveQueryTab();
  activeQueryTabId = id;
  const tab = activeQueryTab();
  if (!tab) return;
  setQueryCode(tab.code);
  elements.queryDataframes.querySelectorAll('input').forEach(input => {
    input.checked = tab.dataframes.includes(input.value);
  });
  if (elements.queryPageSize) elements.queryPageSize.value = String(tab.pageSize);
  elements.queryStatus.textContent = '';
  elements.queryStatus.classList.remove('error');
  if (tab.result) {
    renderQueryResult(tab.result);
  } else {
    elements.queryOutput.hidden = true;
  }
  renderQueryTabs();
  persistQueryTabs();
  requestAnimationFrame(() => monacoEditor?.layout());
};

const restoreQueryTabs = defaultCode => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(QUERY_TABS_STORAGE_KEY) ?? 'null');
    if (!Array.isArray(saved?.tabs) || saved.tabs.length === 0) {
      createQueryTab(defaultCode);
      return;
    }
    queryTabs = saved.tabs.map((tab, index) => ({
      id: typeof tab.id === 'string' ? tab.id : `query-${index + 1}`,
      name: typeof tab.name === 'string' && tab.name.trim() ? tab.name : `Query ${index + 1}`,
      code: typeof tab.code === 'string' ? tab.code : defaultCode,
      dataframes:
        Array.isArray(tab.dataframes) && tab.dataframes.length > 0
          ? tab.dataframes.filter(filename => availableFiles.some(file => file.name === filename))
          : availableFiles.map(file => file.name),
      page: Number.isInteger(tab.page) && tab.page > 0 ? tab.page : 1,
      pageSize: [50, 100, 200, 500].includes(Number(tab.pageSize)) ? Number(tab.pageSize) : 200,
      result: null,
    }));
    nextQueryTabId = queryTabs.reduce((highest, tab) => {
      const match = tab.id.match(/^query-(\d+)$/);
      return Math.max(highest, match ? Number(match[1]) + 1 : highest);
    }, 1);
    const savedActiveId = saved.activeQueryTabId;
    activateQueryTab(queryTabs.some(tab => tab.id === savedActiveId) ? savedActiveId : queryTabs[0].id);
  } catch {
    sessionStorage.removeItem(QUERY_TABS_STORAGE_KEY);
    createQueryTab(defaultCode);
  }
};

const showFallbackEditor = () => {
  elements.queryEditor.hidden = true;
  elements.queryEditorFallback.hidden = false;
};

const loadMonaco = () =>
  new Promise((resolve, reject) => {
    if (typeof window.require !== 'function') {
      reject(new Error('Monaco loader is unavailable.'));
      return;
    }

    window.MonacoEnvironment = {
      getWorkerUrl: () => {
        const workerBootstrap = `
          self.MonacoEnvironment = { baseUrl: '${MONACO_BASE_URL}/' };
          importScripts('${MONACO_BASE_URL}/base/worker/workerMain.js');
        `;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerBootstrap)}`;
      },
    };
    window.require.config({ paths: { vs: MONACO_BASE_URL } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });

const loadPolarsTypes = async monaco => {
  const response = await fetch('/api/polars-types', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not load Polars types (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (!Array.isArray(result.files)) {
    throw new Error('Polars types endpoint returned an invalid response');
  }

  const defaults = monaco.languages.typescript.javascriptDefaults;
  defaults.setCompilerOptions({
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    checkJs: true,
    esModuleInterop: true,
    lib: ['es2022'],
    module: monaco.languages.typescript.ModuleKind.CommonJS,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    skipLibCheck: true,
    target: monaco.languages.typescript.ScriptTarget.ES2022,
  });
  result.files.forEach(file => {
    defaults.addExtraLib(
      file.content,
      `file:///node_modules/nodejs-polars/${file.path}`,
    );
  });
};

const updateFrameTypes = files => {
  if (!monacoApi) {
    return;
  }
  const properties = files
    .map(
      file =>
        `  readonly ${JSON.stringify(file.alias)}: import('nodejs-polars').LazyDataFrame;`,
    )
    .join('\n');
  const declarations = `
declare const pl: typeof import('nodejs-polars').default;
declare const frames: {
${properties}
};
  `;
  frameTypesDisposable?.dispose();
  frameTypesDisposable =
    monacoApi.languages.typescript.javascriptDefaults.addExtraLib(
      declarations,
      'file:///dataframe-debug-environment.d.ts',
    );
};

const initializeQueryEditor = async () => {
  try {
    monacoApi = await loadMonaco();
  } catch {
    showFallbackEditor();
    return;
  }

  monacoEditor = monacoApi.editor.create(elements.queryEditor, {
    automaticLayout: true,
    fontSize: 13,
    language: 'javascript',
    minimap: { enabled: false },
    model: monacoApi.editor.createModel(
      '',
      'javascript',
      monacoApi.Uri.parse('file:///query.js'),
    ),
    scrollBeyondLastLine: false,
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs',
  });
  monacoEditor.getModel().updateOptions({ insertSpaces: true, tabSize: 2 });
  monacoEditor.addCommand(
    monacoApi.KeyMod.CtrlCmd + monacoApi.KeyCode.Enter,
    () => executeQuery(),
  );

  try {
    await loadPolarsTypes(monacoApi);
  } catch {
    elements.queryStatus.textContent =
      'Polars types are unavailable; editor completion is limited.';
  }
};

const parseCsv = csv => {
  const parsedRows = [];
  let row = [];
  let value = '';
  let insideQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const nextCharacter = csv[index + 1];

    if (character === '"' && insideQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === ',' && !insideQuotes) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !insideQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      row.push(value);
      if (row.some(cell => cell.length > 0)) {
        parsedRows.push(row);
      }
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    parsedRows.push(row);
  }
  return parsedRows;
};

const compareValues = (left, right) => {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const bothNumbers =
    left.trim() !== '' &&
    right.trim() !== '' &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber);
  return bothNumbers
    ? leftNumber - rightNumber
    : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
};

const groupRowsByColumn = (frame, column) => {
  const columnIndex = frame.columns.indexOf(column);
  return frame.rows.reduce((groups, row) => {
    const key = row[columnIndex] ?? '';
    groups.set(key, [...(groups.get(key) ?? []), row]);
    return groups;
  }, new Map());
};

const comparePair = (left, right, commonColumns) => {
  if (!left) {
    return 'right-only';
  }
  if (!right) {
    return 'left-only';
  }
  const changed = commonColumns.some(column => {
    const leftIndex = frames.left.columns.indexOf(column);
    const rightIndex = frames.right.columns.indexOf(column);
    return (left[leftIndex] ?? '') !== (right[rightIndex] ?? '');
  });
  return changed ? 'changed' : 'matching';
};

const pairsByPosition = commonColumns =>
  Array.from(
    { length: Math.max(frames.left.rows.length, frames.right.rows.length) },
    (_, index) => {
      const left = frames.left.rows[index];
      const right = frames.right.rows[index];
      return { left, right, state: comparePair(left, right, commonColumns) };
    },
  );

const pairsByColumns = (leftColumn, rightColumn, commonColumns) => {
  const leftGroups = groupRowsByColumn(frames.left, leftColumn);
  const rightGroups = groupRowsByColumn(frames.right, rightColumn);
  const keys = [...new Set([...leftGroups.keys(), ...rightGroups.keys()])];

  return keys.flatMap(key => {
    const leftRows = leftGroups.get(key) ?? [];
    const rightRows = rightGroups.get(key) ?? [];
    return Array.from({ length: Math.max(leftRows.length, rightRows.length) }, (_, index) => {
      const left = leftRows[index];
      const right = rightRows[index];
      return { left, right, state: comparePair(left, right, commonColumns) };
    });
  });
};

const comparisonRows = () => {
  const commonColumns = frames.left.columns.filter(column => frames.right.columns.includes(column));
  const leftMatchColumn = elements.leftMatchColumn.value;
  const rightMatchColumn = elements.rightMatchColumn.value;
  const pairs =
    leftMatchColumn && rightMatchColumn
      ? pairsByColumns(leftMatchColumn, rightMatchColumn, commonColumns)
      : pairsByPosition(commonColumns);
  const query = elements.search.value.trim().toLocaleLowerCase();
  const filteredPairs = query
    ? pairs.filter(({ left = [], right = [] }) =>
        [...left, ...right].some(value => value.toLocaleLowerCase().includes(query)),
      )
    : pairs;
  const visiblePairs = elements.differencesOnly.checked
    ? filteredPairs.filter(pair => pair.state !== 'matching')
    : filteredPairs;

  if (!sort.column) {
    return visiblePairs;
  }
  const frame = frames[sort.side];
  const columnIndex = frame.columns.indexOf(sort.column);
  const direction = sort.direction === 'ascending' ? 1 : -1;
  return [...visiblePairs].sort(
    (left, right) =>
      direction *
      compareValues(left[sort.side]?.[columnIndex] ?? '', right[sort.side]?.[columnIndex] ?? ''),
  );
};

const createCell = (value, changed = false) => {
  const cell = document.createElement('td');
  const displayedValue = value === null || value === undefined ? 'null' : String(value);
  cell.textContent = displayedValue;
  cell.title = displayedValue;
  cell.classList.toggle('changed', changed);
  return cell;
};

const renderHeader = (side, columns) => {
  const frame = frames[side];
  const frameElements = elements[side];
  frameElements.head.replaceChildren();
  const headerRow = document.createElement('tr');
  columns.forEach(column => {
    const header = document.createElement('th');
    const button = document.createElement('button');
    const title = document.createElement('span');
    const subtitle = document.createElement('span');
    const isSorted = sort.side === side && sort.column === column;
    const sortMarker = sort.direction === 'ascending' ? ' ↑' : ' ↓';
    const columnIndex = frame.columns.indexOf(column);
    button.type = 'button';
    button.className = 'column-header';
    title.className = 'column-header-title';
    subtitle.className = 'column-header-type';
    title.textContent = `${column}${isSorted ? sortMarker : ''}`;
    subtitle.textContent = frame.columnTypes?.[columnIndex] ?? '';
    subtitle.hidden = subtitle.textContent === '';
    button.append(title, subtitle);
    button.addEventListener('click', () => {
      sort = {
        side,
        column,
        direction:
          sort.side === side && sort.column === column && sort.direction === 'ascending'
            ? 'descending'
            : 'ascending',
      };
      renderComparison();
    });
    header.append(button);
    headerRow.append(header);
  });
  frameElements.head.append(headerRow);
};

const renderComparisonBody = (side, pairs, commonColumns, columns) => {
  const frame = frames[side];
  const frameElements = elements[side];
  const fragment = document.createDocumentFragment();
  frameElements.body.replaceChildren();

  pairs.forEach(pair => {
    const row = pair[side];
    const tableRow = document.createElement('tr');
    tableRow.classList.add(pair.state);
    if (!row) {
      tableRow.classList.add('missing');
    }
    columns.forEach(column => {
      const index = frame.columns.indexOf(column);
      const otherSide = side === 'left' ? 'right' : 'left';
      const otherFrame = frames[otherSide];
      const otherRow = pair[otherSide];
      const value = row?.[index] ?? '';
      const otherValue = otherRow?.[otherFrame.columns.indexOf(column)] ?? '';
      const changed =
        Boolean(row) && Boolean(otherRow) && commonColumns.includes(column) && value !== otherValue;
      tableRow.append(createCell(value, changed));
    });
    fragment.append(tableRow);
  });
  frameElements.body.append(fragment);
  frameElements.empty.hidden = pairs.length > 0;
  frameElements.empty.textContent = 'No matching rows.';
};

const renderComparison = () => {
  const pairs = comparisonRows();
  const commonColumns = frames.left.columns.filter(column => frames.right.columns.includes(column));
  const leftColumns = frames.left.columns.filter(column => visibleColumns.left.has(column));
  const rightColumns = frames.right.columns.filter(column => visibleColumns.right.has(column));
  renderHeader('left', leftColumns);
  renderHeader('right', rightColumns);
  renderComparisonBody('left', pairs, commonColumns, leftColumns);
  renderComparisonBody('right', pairs, commonColumns, rightColumns);

  const counts = pairs.reduce(
    (summary, pair) => ({ ...summary, [pair.state]: summary[pair.state] + 1 }),
    { matching: 0, changed: 0, 'left-only': 0, 'right-only': 0 },
  );
  elements.comparisonStatus.textContent = `${pairs.length.toLocaleString()} rows · ${counts.changed.toLocaleString()} changed · ${counts['left-only'].toLocaleString()} left only · ${counts['right-only'].toLocaleString()} right only`;
};

const loadDataset = async (filename, page = 1, pageSize = Number(elements.comparePageSize?.value ?? 200)) => {
  const response = await fetch(
    `/api/dataframe?filename=${encodeURIComponent(filename)}&page=${page}&pageSize=${pageSize}`,
    {
      cache: 'no-store',
    },
  );
  if (!response.ok) {
    throw new Error(`Could not load ${filename} (HTTP ${response.status})`);
  }
  return response.json();
};

const loadDatasetFiles = async () => {
  const response = await fetch('/api/dataframe-files', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not discover DataFrame files (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (!Array.isArray(result.files)) {
    throw new Error('DataFrame file endpoint returned an invalid response');
  }
  return result.files;
};

const refreshAvailableFiles = async () => {
  availableFiles = await loadDatasetFiles();
  populateDatasetSelectors(availableFiles);
  renderQueryDataframes(availableFiles);
  updateFrameTypes(availableFiles);
  if (availableFiles.length > 0) {
    if (!availableFiles.some(file => file.name === elements.leftDataset.value)) {
      elements.leftDataset.selectedIndex = 0;
    }
    if (!availableFiles.some(file => file.name === elements.rightDataset.value)) {
      elements.rightDataset.selectedIndex = Math.min(1, availableFiles.length - 1);
    }
  }
};

const uploadDataframes = async files => {
  elements.dataframeUpload.disabled = true;
  elements.uploadStatus.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;
  try {
    for (const file of files) {
      const response = await fetch('/api/dataframe-upload', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-DataFrame-Filename': file.name,
        },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? `Could not upload ${file.name}`);
      }
    }
    await refreshAvailableFiles();
    elements.uploadStatus.textContent = `${files.length} file${files.length === 1 ? '' : 's'} uploaded.`;
    if (availableFiles.length > 0) {
      await loadComparison();
    }
  } catch (error) {
    elements.uploadStatus.textContent = error instanceof Error ? error.message : 'Upload failed.';
  } finally {
    elements.dataframeUpload.disabled = false;
    elements.dataframeUpload.value = '';
  }
};

const updateMatchColumn = (select, columns) => {
  const previousValue = select.value;
  const preferredColumn = ['meeting_id', 'id', 'relationship_id'].find(column =>
    columns.includes(column),
  );
  select.replaceChildren();
  const rowPositionOption = document.createElement('option');
  rowPositionOption.value = '';
  rowPositionOption.textContent = 'Row position';
  select.append(rowPositionOption);
  columns.forEach(column => {
    const option = document.createElement('option');
    option.value = column;
    option.textContent = column;
    select.append(option);
  });
  select.value = columns.includes(previousValue) ? previousValue : (preferredColumn ?? '');
};

const updateColumnPicker = side => {
  const frame = frames[side];
  const frameElements = elements[side];
  const selectedColumns = visibleColumns[side];
  frameElements.columnSummary.textContent = `${selectedColumns.size} of ${frame.columns.length} columns`;
  frameElements.columnOptions.replaceChildren();

  frame.columns.forEach(column => {
    const option = document.createElement('label');
    const checkbox = document.createElement('input');
    const isSelected = selectedColumns.has(column);
    option.className = 'column-option';
    checkbox.type = 'checkbox';
    checkbox.checked = isSelected;
    checkbox.disabled = isSelected && selectedColumns.size === 1;
    checkbox.addEventListener('change', () => {
      const nextColumns = checkbox.checked
        ? new Set([...visibleColumns[side], column])
        : new Set([...visibleColumns[side]].filter(candidate => candidate !== column));
      visibleColumns = { ...visibleColumns, [side]: nextColumns };
      if (!checkbox.checked && sort.side === side && sort.column === column) {
        sort = { side: '', column: '', direction: 'ascending' };
      }
      updateColumnPicker(side);
      renderComparison();
    });
    option.append(checkbox, column);
    frameElements.columnOptions.append(option);
  });
};

const updateComparePagination = result => {
  const totalPages = Number(result.totalPages ?? 1);
  const page = Number(result.page ?? 1);
  elements.comparePageIndicator.textContent = `Page ${page.toLocaleString()} of ${totalPages.toLocaleString()}`;
  elements.comparePrevPage.disabled = page <= 1;
  elements.compareNextPage.disabled = page >= totalPages;
  elements.comparePaginationControls.hidden = totalPages <= 1;
};

const loadComparison = async () => {
  elements.comparisonStatus.textContent = 'Loading DataFrames…';
  try {
    const [left, right] = await Promise.all([
      loadDataset(elements.leftDataset.value, comparePage, Number(elements.comparePageSize?.value ?? 200)),
      loadDataset(elements.rightDataset.value, comparePage, Number(elements.comparePageSize?.value ?? 200)),
    ]);
    frames = { left, right };
    sort = { side: '', column: '', direction: 'ascending' };
    visibleColumns = { left: new Set(left.columns), right: new Set(right.columns) };
    elements.left.title.textContent = describeDataframeFile(left);
    elements.right.title.textContent = describeDataframeFile(right);
    updateMatchColumn(elements.leftMatchColumn, left.columns);
    updateMatchColumn(elements.rightMatchColumn, right.columns);
    updateColumnPicker('left');
    updateColumnPicker('right');
    updateComparePagination(left);
    renderComparison();
  } catch (error) {
    elements.comparisonStatus.textContent =
      error instanceof Error ? error.message : 'Unable to load DataFrames';
  }
};

const populateDatasetSelectors = files => {
  [elements.leftDataset, elements.rightDataset].forEach(dataset => {
    dataset.replaceChildren();
    files.forEach(file => {
      const option = document.createElement('option');
      option.value = file.name;
      option.textContent = describeDataframeFile(file);
      dataset.append(option);
    });
  });
};

const renderQueryDataframes = files => {
  elements.queryDataframes.replaceChildren();
  files.forEach((file, index) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const details = document.createElement('span');
    const filename = document.createElement('span');
    const alias = document.createElement('code');
    const badge = document.createElement('span');
    label.className = 'query-dataframe';
    checkbox.type = 'checkbox';
    checkbox.value = file.name;
    checkbox.checked = true;
    filename.textContent = file.name;
    badge.className = 'file-badge';
    badge.textContent = file.metadataLabel ? `${file.label} · ${file.metadataLabel}` : file.label;
    alias.textContent = `frames.${file.alias}`;
    details.append(filename, badge, document.createElement('br'), alias);
    label.append(checkbox, details);
    elements.queryDataframes.append(label);
  });
};

const updateQueryPagination = result => {
  const totalPages = Number(result.totalPages ?? 1);
  const page = Number(result.page ?? 1);
  elements.queryPageIndicator.textContent = `Page ${page.toLocaleString()} of ${totalPages.toLocaleString()}`;
  elements.queryPrevPage.disabled = page <= 1;
  elements.queryNextPage.disabled = page >= totalPages;
  elements.queryPaginationControls.hidden = totalPages <= 1;
};

const renderQueryResult = result => {
  elements.queryOutput.hidden = false;
  elements.queryMetadata.textContent = `${result.rowCount.toLocaleString()} of ${result.totalRows.toLocaleString()} rows · ${result.durationMs.toLocaleString()} ms`;
  elements.queryHead.replaceChildren();
  elements.queryBody.replaceChildren();

  const headerRow = document.createElement('tr');
  result.columns.forEach((column, index) => {
    const header = document.createElement('th');
    const label = document.createElement('button');
    const title = document.createElement('span');
    const subtitle = document.createElement('span');
    label.type = 'button';
    label.className = 'column-header';
    title.className = 'column-header-title';
    subtitle.className = 'column-header-type';
    title.textContent = column;
    subtitle.textContent = result.columnTypes?.[index] ?? '';
    subtitle.hidden = subtitle.textContent === '';
    label.append(title, subtitle);
    header.append(label);
    headerRow.append(header);
  });
  elements.queryHead.append(headerRow);

  const fragment = document.createDocumentFragment();
  result.rows.forEach(row => {
    const tableRow = document.createElement('tr');
    result.columns.forEach(column => tableRow.append(createCell(row[column])));
    fragment.append(tableRow);
  });
  elements.queryBody.append(fragment);
  elements.queryPlan.textContent = result.plan || 'Eager DataFrame: no lazy plan available.';
  elements.queryOptimizedPlan.textContent =
    result.optimizedPlan || 'Eager DataFrame: no optimized lazy plan available.';
  updateQueryPagination(result);
};

const selectedQueryDataframes = () =>
  [...elements.queryDataframes.querySelectorAll('input:checked')].map(input => input.value);

const executeQuery = async (page = activeQueryTab()?.page ?? 1) => {
  const tab = activeQueryTab();
  if (!tab) return;
  const code = queryCode().trim();
  const dataframes = selectedQueryDataframes();
  tab.code = code;
  tab.dataframes = dataframes;
  elements.queryStatus.classList.remove('error');
  if (!code || dataframes.length === 0) {
    elements.queryStatus.classList.add('error');
    elements.queryStatus.textContent = code
      ? 'Select at least one DataFrame.'
      : 'Enter a Polars expression.';
    return;
  }

  elements.runQuery.disabled = true;
  elements.queryStatus.textContent = 'Running query…';
  sessionStorage.setItem('dataframe-debug-query', code);
  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        dataframes,
        page,
        pageSize: Number(elements.queryPageSize?.value ?? 200),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? `Query failed (HTTP ${response.status})`);
    }
    tab.page = page;
    tab.pageSize = Number(elements.queryPageSize?.value ?? 200);
    tab.result = result;
    renderQueryResult(result);
    elements.queryStatus.textContent = 'Query complete.';
  } catch (error) {
    elements.queryStatus.classList.add('error');
    elements.queryStatus.textContent =
      error instanceof Error ? error.message : 'Unable to execute query.';
  } finally {
    elements.runQuery.disabled = false;
  }
};

const attachPaginationHandlers = () => {
  elements.comparePageSize?.addEventListener('change', () => {
    comparePage = 1;
    loadComparison();
  });

  elements.comparePrevPage?.addEventListener('click', () => {
    if (comparePage > 1) {
      comparePage -= 1;
      loadComparison();
    }
  });

  elements.compareNextPage?.addEventListener('click', () => {
    comparePage += 1;
    loadComparison();
  });

  elements.queryPageSize?.addEventListener('change', () => {
    const tab = activeQueryTab();
    if (tab) tab.page = 1;
    executeQuery(1);
  });

  elements.queryPrevPage?.addEventListener('click', () => {
    const tab = activeQueryTab();
    if (tab?.page > 1) {
      executeQuery(tab.page - 1);
    }
  });

  elements.queryNextPage?.addEventListener('click', () => {
    executeQuery((activeQueryTab()?.page ?? 1) + 1);
  });
};

const initialize = async () => {
  try {
    availableFiles = await loadDatasetFiles();
    if (availableFiles.length === 0) {
      elements.comparisonStatus.textContent =
        'No DataFrame files found. Generate an export, then refresh.';
      elements.queryStatus.textContent = 'No DataFrame files available for queries.';
      return;
    }

    populateDatasetSelectors(availableFiles);
    renderQueryDataframes(availableFiles);
    updateFrameTypes(availableFiles);
    attachPaginationHandlers();
    elements.rightDataset.selectedIndex = availableFiles.length > 1 ? 1 : 0;
    createQueryTab(
      sessionStorage.getItem('dataframe-debug-query') ??
        `return frames.${availableFiles[0].alias}\n  .limit(100)`,
    );
    await loadComparison();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to initialize viewer';
    elements.comparisonStatus.textContent = message;
    elements.queryStatus.textContent = message;
  }
};

elements.dataframeUpload.addEventListener('change', event => {
  const files = [...event.target.files];
  if (files.length > 0) {
    uploadDataframes(files);
  }
});

elements.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    elements.tabs.forEach(candidate => {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      document.querySelector(candidate.dataset.panel).hidden = !selected;
    });
    requestAnimationFrame(() => monacoEditor?.layout());
  });
});
elements.leftDataset.addEventListener('change', loadComparison);
elements.rightDataset.addEventListener('change', loadComparison);
elements.leftMatchColumn.addEventListener('change', renderComparison);
elements.rightMatchColumn.addEventListener('change', renderComparison);
elements.search.addEventListener('input', renderComparison);
elements.differencesOnly.addEventListener('change', renderComparison);
elements.left.showAllColumns.addEventListener('click', () => {
  visibleColumns = { ...visibleColumns, left: new Set(frames.left.columns) };
  updateColumnPicker('left');
  renderComparison();
});
elements.right.showAllColumns.addEventListener('click', () => {
  visibleColumns = { ...visibleColumns, right: new Set(frames.right.columns) };
  updateColumnPicker('right');
  renderComparison();
});

document.addEventListener('click', event => {
  // If the click happened outside the details element, remove the "open" attribute
  elements.columnPickers.forEach(picker => {
    if (!picker.contains(event.target)) {
      picker.removeAttribute('open');
    }
  });
});

elements.runQuery.addEventListener('click', () => executeQuery(1));
elements.newQueryTab.addEventListener('click', () => createQueryTab());
elements.queryEditorFallback.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    executeQuery();
  }
});
window.addEventListener('beforeunload', saveActiveQueryTab);

let syncingScroll = false;
const syncScroll = (source, destination) => {
  if (syncingScroll) {
    return;
  }
  syncingScroll = true;
  destination.scrollTop = source.scrollTop;
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
};
elements.left.container.addEventListener('scroll', () =>
  syncScroll(elements.left.container, elements.right.container),
);
elements.right.container.addEventListener('scroll', () =>
  syncScroll(elements.right.container, elements.left.container),
);

initializeQueryEditor().then(initialize);
