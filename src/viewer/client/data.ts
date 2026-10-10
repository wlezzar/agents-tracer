import type { IndexData, PageData, ViewData } from '../../view/types.js';

// The page's data, embedded by renderHtml as JSON in <script id="trace-data">, checked for the
// shape the viewer reads before it is used.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLane(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['label'] === 'string' &&
    typeof value['group'] === 'string' &&
    Array.isArray(value['seg']) &&
    Array.isArray(value['spans']) &&
    Array.isArray(value['turns']) &&
    Array.isArray(value['buckets']) &&
    Array.isArray(value['bash']) &&
    isRecord(value['stats'])
  );
}

export function isIndexData(value: unknown): value is IndexData {
  if (!isRecord(value)) return false;
  const index = value['index'];
  return (
    isRecord(index) &&
    typeof index['projectDir'] === 'string' &&
    typeof index['agent'] === 'string' &&
    Array.isArray(index['sessions'])
  );
}

export function isViewData(value: unknown): value is ViewData {
  if (!isRecord(value)) return false;
  const { session, groups, lanes, toolCategories, shellLabel } = value;
  return (
    isRecord(session) &&
    typeof session['id'] === 'string' &&
    Array.isArray(groups) &&
    groups.every(isRecord) &&
    Array.isArray(lanes) &&
    lanes.length > 0 &&
    lanes.every(isLane) &&
    isRecord(toolCategories) &&
    typeof shellLabel === 'string'
  );
}

/** The data embedded in the page; throws when it holds neither a session nor an index. */
export function readPageData(): PageData {
  const text = document.getElementById('trace-data')?.textContent ?? 'null';
  const data: unknown = JSON.parse(text);
  if (isIndexData(data) || isViewData(data)) return data;
  throw new Error('the page holds no view data');
}
