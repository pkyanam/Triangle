import type { SceneObjectSummary, SceneSummary } from '@triangle/shared';

export interface OutlinerRow {
  uuid: string;
  name: string;
  type: string;
  visible: boolean;
  depth: number;
  hasChildren: boolean;
}

export function flattenSceneSummary(summary: SceneSummary): OutlinerRow[] {
  const rows: OutlinerRow[] = [];
  const walk = (list: SceneObjectSummary[], depth: number) => {
    for (const obj of list) {
      const children = obj.children ?? [];
      rows.push({
        uuid: obj.uuid,
        name: obj.name,
        type: obj.type,
        visible: obj.visible,
        depth,
        hasChildren: children.length > 0,
      });
      walk(children, depth + 1);
    }
  };
  walk(summary.objects, 0);
  return rows;
}
