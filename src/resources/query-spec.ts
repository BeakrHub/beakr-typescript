/**
 * Typed shapes for a `knowledge.query` spec (the `query` command). A spec is
 * plain JSON, sent as is; the engine validates it and refuses one it cannot run
 * with `invalid_arguments`, naming the key, what is allowed and, for an unknown
 * field, the closest field names.
 */

export type QueryTable = "facts" | "connections" | "findings";
export type QueryTextOp = "eq" | "contains" | "in";
export type QueryValueOp = "eq" | "ne" | "contains" | "in" | "gt" | "gte" | "lt" | "lte" | "between";
export type QueryLinkOp = "eq" | "contains";
export type QueryFieldMatch = "exact" | "similar" | "meaning";
export type QueryAggregateFn = "count" | "count_distinct" | "min" | "max" | "sum" | "avg";

/** `from` as a table with an alias, for joins and aliased conditions. */
export interface QueryFromTable {
  table: QueryTable;
  as: string;
}

interface Aliased {
  /** Which joined table a condition reads (the `as` of `from` or a join). */
  alias?: string;
}

export interface QueryEntityCondition extends Aliased {
  entity: string | string[];
  op?: QueryTextOp;
}

export interface QueryEntityTypeCondition extends Aliased {
  entity_type: string | string[];
  op?: QueryTextOp;
}

export interface QueryFieldCondition extends Aliased {
  field: string;
  match?: QueryFieldMatch;
}

export interface QueryValueCondition extends Aliased {
  /** `gt` .. `lte` take a number or a YYYY-MM-DD date; `between` takes [low, high]. */
  value: string | number | string[] | number[];
  op?: QueryValueOp;
}

export interface QueryWhenCondition extends Aliased {
  when: { from?: string; to?: string };
}

/** Facts only, at the top level of `where`: each card's value on that day. */
export interface QueryAsOfCondition {
  as_of: string;
}

export interface QueryToCondition extends Aliased {
  to: string;
  op?: QueryLinkOp;
}

export interface QueryConnectedToCondition extends Aliased {
  connected_to: string;
  op?: QueryLinkOp;
}

export type QueryCondition =
  | QueryEntityCondition
  | QueryEntityTypeCondition
  | QueryFieldCondition
  | QueryValueCondition
  | QueryWhenCondition
  | QueryAsOfCondition
  | QueryToCondition
  | QueryConnectedToCondition
  | { and: QueryCondition[] }
  | { or: QueryCondition[] }
  | { not: QueryCondition };

/** `on: "target_card"` needs a connections table on its `with` side. */
export interface QueryJoin {
  table: QueryTable;
  as: string;
  on: "same_card" | "target_card";
  with: string;
}

export interface QueryAggregate {
  fn: QueryAggregateFn;
  /** A group key for `count_distinct`; `value_number`, `value_amount` or `value_date` for the others. */
  of: string;
}

export interface QueryOrderBy {
  /** An aggregate's label, a group key, `value_number`, `value_amount`, `value_date` or `when`. */
  by: string;
  dir?: "asc" | "desc";
}

export type QuerySemantic =
  | { rank_fields_by: string }
  | { field_near: string; /** 0.3 .. 0.99. */ threshold?: number; alias?: string };

export interface QuerySpec {
  from?: QueryTable | QueryFromTable;
  where?: QueryCondition;
  join?: QueryJoin[];
  group_by?: string[];
  aggregate?: QueryAggregate[];
  order_by?: QueryOrderBy[];
  /** 1 .. 200; the engine's default is 50. */
  limit?: number;
  /** The opaque cursor a previous reply handed out. */
  cursor?: string;
  semantic?: QuerySemantic;
}
