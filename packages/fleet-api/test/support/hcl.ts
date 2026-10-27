import { read } from './sql-source';

export interface HclColumn {
  readonly type: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly identity: boolean;
}

export type HclSchema = Readonly<
  Record<string, Readonly<Record<string, HclColumn>>>
>;

function parseColumn(body: string): HclColumn {
  const type = /^\s*type\s*=\s*(?:sql\("([^"]+)"\)|(\w+))/m.exec(body);
  return {
    type: type?.[1] ?? type?.[2] ?? '',
    nullable: /^\s*null\s*=\s*true/m.test(body),
    hasDefault: /^\s*default\s*=/m.test(body),
    identity: /^\s*identity\s*\{/m.test(body),
  };
}

/** Reads the tables and columns of schema.hcl. It understands only the subset that file uses. */
export function parseSchemaHcl(): HclSchema {
  const tables: Record<string, Record<string, HclColumn>> = {};
  const blocks = read('schema.hcl').matchAll(
    /^table "(\w+)" \{\n([\s\S]*?)\n\}$/gm
  );
  for (const [, name = '', body = ''] of blocks) {
    const columns: Record<string, HclColumn> = {};
    for (const [, column = '', inner = ''] of body.matchAll(
      /^ {2}column "(\w+)" \{\n([\s\S]*?)\n {2}\}$/gm
    )) {
      columns[column] = parseColumn(inner);
    }
    tables[name] = columns;
  }
  return tables;
}
