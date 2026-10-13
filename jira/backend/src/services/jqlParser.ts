/**
 * JQL (Jira Query Language) parser.
 *
 * Parses queries such as
 *   project = DEMO AND status IN ("To Do", "In Progress") AND assignee = currentUser()
 *   ORDER BY priority DESC
 * into an AST, then translates the AST into an Elasticsearch bool query.
 *
 * Grammar (AND binds tighter than OR, as in Jira; keywords are case-insensitive):
 *   query    := [ orExpr ] [ ORDER BY sortKey ( , sortKey )* ] EOF
 *   orExpr   := andExpr ( OR andExpr )*
 *   andExpr  := notExpr ( AND notExpr )*
 *   notExpr  := NOT notExpr | primary
 *   primary  := ( orExpr ) | clause
 *   clause   := field operator operand
 *   operator := = | != | ~ | !~ | > | < | >= | <= | IN | NOT IN | IS | IS NOT
 *   operand  := value | function | ( value ( , value )* )      lists only after IN / NOT IN
 *   value    := quoted string | bare word | EMPTY | NULL
 *   function := name ( )        currentUser, now, startOfDay, endOfDay, startOfWeek, endOfWeek
 *   sortKey  := field [ ASC | DESC ]
 *
 * Every syntax problem raises JQLSyntaxError with the character position; nothing is
 * silently ignored, because a filter that quietly drops a clause returns wrong issues.
 */

export type JQLOperator = '=' | '!=' | '~' | '!~' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT IN' | 'IS' | 'IS NOT';

export type JQLLogical = 'AND' | 'OR';

/** A function call in a value position, e.g. currentUser(). */
export interface JQLFunction {
  type: 'function';
  name: string;
  args: string[];
}

/** A clause value: literal text, a function, EMPTY/NULL (null), or a list for IN. */
export type JQLValue = string | null | JQLFunction | (string | JQLFunction)[];

/** A single field comparison clause. */
export interface JQLClause {
  type: 'clause';
  field: string;
  operator: JQLOperator;
  value: JQLValue;
}

/** Clauses combined with AND or OR. */
export interface JQLGroup {
  type: 'group';
  logical: JQLLogical;
  clauses: JQLNode[];
}

/** NOT applied to a clause or group. */
export interface JQLNot {
  type: 'not';
  operand: JQLNode;
}

export type JQLNode = JQLClause | JQLGroup | JQLNot;

export interface JQLSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface JQLQuery {
  /** Null when the query has only ORDER BY (or is empty): match every issue. */
  where: JQLNode | null;
  orderBy: JQLSort[];
}

/** Invalid query. position is the character offset, or -1 for errors about a value. */
export class JQLSyntaxError extends Error {
  constructor(message: string, public readonly position: number = -1) {
    super(position >= 0 ? `${message} (at position ${position})` : message);
    this.name = 'JQLSyntaxError';
  }
}

type FieldType = 'keyword' | 'text' | 'number' | 'date' | 'user';

interface FieldSpec {
  type: FieldType;
  /** Elasticsearch field holding the value. */
  es: string;
  /** For user fields: the id field that currentUser() is compared against. */
  idField?: string;
  /** For text fields: a keyword sub-field used by = and sorting. */
  exact?: string;
}

/** JQL field name (lowercase) to its type and index field. Aliases share a spec. */
const FIELDS: Record<string, FieldSpec> = {
  project: { type: 'keyword', es: 'project_key' },
  key: { type: 'keyword', es: 'key' },
  issuekey: { type: 'keyword', es: 'key' },
  status: { type: 'keyword', es: 'status' },
  statuscategory: { type: 'keyword', es: 'status_category' },
  priority: { type: 'keyword', es: 'priority' },
  type: { type: 'keyword', es: 'issue_type' },
  issuetype: { type: 'keyword', es: 'issue_type' },
  sprint: { type: 'keyword', es: 'sprint_name' },
  epic: { type: 'keyword', es: 'epic_key' },
  labels: { type: 'keyword', es: 'labels' },
  label: { type: 'keyword', es: 'labels' },
  component: { type: 'keyword', es: 'components' },
  components: { type: 'keyword', es: 'components' },
  assignee: { type: 'user', es: 'assignee_name', idField: 'assignee_id' },
  reporter: { type: 'user', es: 'reporter_name', idField: 'reporter_id' },
  summary: { type: 'text', es: 'summary', exact: 'summary.keyword' },
  description: { type: 'text', es: 'description' },
  text: { type: 'text', es: 'text' },
  created: { type: 'date', es: 'created_at' },
  updated: { type: 'date', es: 'updated_at' },
  storypoints: { type: 'number', es: 'story_points' },
  story_points: { type: 'number', es: 'story_points' },
};

/** Canonical names for aliases, so the AST uses one spelling per field. */
const CANONICAL: Record<string, string> = {
  issuekey: 'key',
  issuetype: 'type',
  label: 'labels',
  components: 'component',
  storypoints: 'story_points',
};

const FUNCTIONS = ['currentuser', 'now', 'startofday', 'endofday', 'startofweek', 'endofweek'];

const OPERATORS_BY_TYPE: Record<FieldType, JQLOperator[]> = {
  keyword: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
  user: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
  text: ['~', '!~', '=', 'IS', 'IS NOT'],
  number: ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
  date: ['=', '!=', '>', '<', '>=', '<=', 'IS', 'IS NOT'],
};

type TokenKind = 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'comma';

interface Token {
  kind: TokenKind;
  text: string;
  position: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '(' || char === ')' || char === ',') {
      tokens.push({ kind: char === '(' ? 'lparen' : char === ')' ? 'rparen' : 'comma', text: char, position: i });
      i++;
      continue;
    }

    const twoChar = input.slice(i, i + 2);
    if (['!=', '>=', '<=', '!~'].includes(twoChar)) {
      tokens.push({ kind: 'op', text: twoChar, position: i });
      i += 2;
      continue;
    }
    if (['=', '>', '<', '~'].includes(char)) {
      tokens.push({ kind: 'op', text: char, position: i });
      i++;
      continue;
    }

    if (char === '"' || char === "'") {
      const start = i;
      let value = '';
      i++;
      while (i < input.length && input[i] !== char) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        value += input[i];
        i++;
      }
      if (i >= input.length) throw new JQLSyntaxError('Unterminated string', start);
      i++;
      tokens.push({ kind: 'string', text: value, position: start });
      continue;
    }

    const wordMatch = input.slice(i).match(/^(cf\[[^\]]+\]|[A-Za-z0-9_.:@/-]+)/);
    if (!wordMatch) throw new JQLSyntaxError(`Unexpected character "${char}"`, i);
    tokens.push({ kind: 'word', text: wordMatch[0], position: i });
    i += wordMatch[0].length;
  }

  return tokens;
}

/** Recursive-descent parser over the token list for one query. */
class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[], private readonly length: number) {}

  parseQuery(): JQLQuery {
    let where: JQLNode | null = null;
    if (this.peek() && !this.peekKeyword('ORDER')) {
      where = this.parseOr();
    }
    const orderBy = this.peekKeyword('ORDER') ? this.parseOrderBy() : [];
    const extra = this.peek();
    if (extra) throw new JQLSyntaxError(`Unexpected "${extra.text}"`, extra.position);
    return { where, orderBy };
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  private peekKeyword(keyword: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'word' && token.text.toUpperCase() === keyword;
  }

  private next(expected: string): Token {
    const token = this.tokens[this.position++];
    if (!token) throw new JQLSyntaxError(`Expected ${expected} but the query ended`, this.length);
    return token;
  }

  private parseOr(): JQLNode {
    const clauses = [this.parseAnd()];
    while (this.peekKeyword('OR')) {
      this.position++;
      clauses.push(this.parseAnd());
    }
    return clauses.length === 1 ? clauses[0] : { type: 'group', logical: 'OR', clauses };
  }

  private parseAnd(): JQLNode {
    const clauses = [this.parseNot()];
    while (this.peekKeyword('AND')) {
      this.position++;
      clauses.push(this.parseNot());
    }
    return clauses.length === 1 ? clauses[0] : { type: 'group', logical: 'AND', clauses };
  }

  private parseNot(): JQLNode {
    if (this.peekKeyword('NOT')) {
      this.position++;
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): JQLNode {
    const token = this.peek();
    if (token?.kind === 'lparen') {
      this.position++;
      const inner = this.parseOr();
      const close = this.next('")"');
      if (close.kind !== 'rparen') throw new JQLSyntaxError(`Expected ")" but found "${close.text}"`, close.position);
      return inner;
    }
    return this.parseClause();
  }

  private parseField(): string {
    const token = this.next('a field name');
    if (token.kind !== 'word') throw new JQLSyntaxError(`Expected a field name but found "${token.text}"`, token.position);
    const raw = token.text.toLowerCase();
    if (/^cf\[[^\]]+\]$/.test(raw)) return raw;
    if (!FIELDS[raw]) throw new JQLSyntaxError(`Unknown field "${token.text}"`, token.position);
    return CANONICAL[raw] ?? raw;
  }

  private parseOperator(): JQLOperator {
    const token = this.next('an operator');
    if (token.kind === 'op') return token.text as JQLOperator;
    const word = token.kind === 'word' ? token.text.toUpperCase() : '';
    if (word === 'IN') return 'IN';
    if (word === 'NOT' && this.peekKeyword('IN')) {
      this.position++;
      return 'NOT IN';
    }
    if (word === 'IS') {
      if (this.peekKeyword('NOT')) {
        this.position++;
        return 'IS NOT';
      }
      return 'IS';
    }
    throw new JQLSyntaxError(`Expected an operator but found "${token.text}"`, token.position);
  }

  private parseClause(): JQLClause {
    const fieldToken = this.peek();
    const field = this.parseField();
    const operator = this.parseOperator();
    const spec = specFor(field);

    if (!OPERATORS_BY_TYPE[spec.type].includes(operator)) {
      throw new JQLSyntaxError(`Operator ${operator} is not supported for ${field}`, fieldToken?.position ?? 0);
    }

    let value: JQLValue;
    if (operator === 'IN' || operator === 'NOT IN') {
      value = this.parseList();
    } else if (operator === 'IS' || operator === 'IS NOT') {
      const token = this.next('EMPTY or NULL');
      const word = token.kind === 'word' ? token.text.toUpperCase() : '';
      if (word !== 'EMPTY' && word !== 'NULL') {
        throw new JQLSyntaxError(`${operator} must be followed by EMPTY or NULL`, token.position);
      }
      value = null;
    } else {
      value = this.parseValue();
    }

    return { type: 'clause', field, operator, value };
  }

  private parseList(): (string | JQLFunction)[] {
    const open = this.next('"("');
    if (open.kind !== 'lparen') throw new JQLSyntaxError('IN needs a list such as ("A", "B")', open.position);
    const values: (string | JQLFunction)[] = [];
    for (;;) {
      const value = this.parseValue();
      if (value === null) throw new JQLSyntaxError('EMPTY is not allowed in a list', open.position);
      values.push(value);
      const separator = this.next('"," or ")"');
      if (separator.kind === 'rparen') return values;
      if (separator.kind !== 'comma') {
        throw new JQLSyntaxError(`Expected "," or ")" but found "${separator.text}"`, separator.position);
      }
    }
  }

  private parseValue(): string | JQLFunction | null {
    const token = this.next('a value');
    if (token.kind === 'string') return token.text;
    if (token.kind !== 'word') throw new JQLSyntaxError(`Expected a value but found "${token.text}"`, token.position);

    const upper = token.text.toUpperCase();
    if (upper === 'EMPTY' || upper === 'NULL') return null;

    if (this.peek()?.kind === 'lparen') {
      const name = token.text.toLowerCase();
      if (!FUNCTIONS.includes(name)) throw new JQLSyntaxError(`Unknown function "${token.text}()"`, token.position);
      this.position++;
      const close = this.next('")"');
      if (close.kind !== 'rparen') throw new JQLSyntaxError(`${token.text}() takes no arguments`, close.position);
      return { type: 'function', name, args: [] };
    }

    if (['AND', 'OR', 'NOT', 'ORDER'].includes(upper)) {
      throw new JQLSyntaxError(`Expected a value but found the keyword ${upper}`, token.position);
    }
    return token.text;
  }

  private parseOrderBy(): JQLSort[] {
    this.position++;
    if (!this.peekKeyword('BY')) {
      const token = this.peek();
      throw new JQLSyntaxError('Expected BY after ORDER', token?.position ?? this.length);
    }
    this.position++;
    const sorts: JQLSort[] = [];
    for (;;) {
      const field = this.parseField();
      let direction: 'asc' | 'desc' = 'asc';
      if (this.peekKeyword('ASC') || this.peekKeyword('DESC')) {
        direction = this.next('a direction').text.toLowerCase() as 'asc' | 'desc';
      }
      sorts.push({ field, direction });
      if (this.peek()?.kind !== 'comma') return sorts;
      this.position++;
    }
  }
}

function specFor(field: string): FieldSpec {
  if (field.startsWith('cf[')) {
    return { type: 'keyword', es: `custom_fields.${field.slice(3, -1)}` };
  }
  return FIELDS[field];
}

/** Context used to resolve functions such as currentUser() at query time. */
export interface JQLContext {
  currentUserId?: string;
  now?: Date;
}

type Resolved = { kind: 'user'; id: string } | { kind: 'literal'; value: string };

function resolve(value: string | JQLFunction, context: JQLContext): Resolved {
  if (typeof value === 'string') return { kind: 'literal', value };
  const now = context.now ?? new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (value.name) {
    case 'currentuser':
      return { kind: 'user', id: context.currentUserId ?? '' };
    case 'now':
      return { kind: 'literal', value: now.toISOString() };
    case 'startofday':
      return { kind: 'literal', value: day.toISOString() };
    case 'endofday':
      return { kind: 'literal', value: new Date(day.getTime() + 86_400_000 - 1).toISOString() };
    case 'startofweek': {
      const start = new Date(day.getTime() - day.getUTCDay() * 86_400_000);
      return { kind: 'literal', value: start.toISOString() };
    }
    case 'endofweek': {
      const end = new Date(day.getTime() + (7 - day.getUTCDay()) * 86_400_000 - 1);
      return { kind: 'literal', value: end.toISOString() };
    }
    default:
      throw new JQLSyntaxError(`Unknown function "${value.name}()"`);
  }
}

/** Jira-style relative dates ("-7d", "-2w", "+4h") become Elasticsearch date math. */
function dateValue(raw: string): string {
  return /^[-+]\d+[mhdw]$/.test(raw) ? `now${raw}` : raw;
}

/** One equality test, case-insensitive for keyword fields like status names. */
function equals(spec: FieldSpec, value: Resolved): Record<string, unknown> {
  if (value.kind === 'user') {
    return { term: { [spec.idField ?? spec.es]: value.id } };
  }
  if (spec.type === 'number') {
    const number = Number(value.value);
    if (Number.isNaN(number)) throw new JQLSyntaxError(`"${value.value}" is not a number`);
    return { term: { [spec.es]: number } };
  }
  if (spec.type === 'date') {
    return { term: { [spec.es]: dateValue(value.value) } };
  }
  if (spec.type === 'text') {
    if (!spec.exact) throw new JQLSyntaxError('Use ~ to search this text field');
    return { term: { [spec.exact]: { value: value.value, case_insensitive: true } } };
  }
  return { term: { [spec.es]: { value: value.value, case_insensitive: true } } };
}

function not(query: Record<string, unknown>): Record<string, unknown> {
  return { bool: { must_not: [query] } };
}

function clauseToElasticsearch(clause: JQLClause, context: JQLContext): Record<string, unknown> {
  const spec = specFor(clause.field);
  const exists = { exists: { field: spec.type === 'user' ? spec.es : spec.exact ?? spec.es } };

  if (clause.value === null) {
    // = EMPTY, IS EMPTY, != EMPTY, IS NOT EMPTY
    return clause.operator === '=' || clause.operator === 'IS' ? not(exists) : exists;
  }

  if (Array.isArray(clause.value)) {
    const anyOf = {
      bool: {
        should: clause.value.map((v) => equals(spec, resolve(v, context))),
        minimum_should_match: 1,
      },
    };
    return clause.operator === 'IN' ? anyOf : not(anyOf);
  }

  const value = resolve(clause.value, context);

  switch (clause.operator) {
    case '=':
      return equals(spec, value);
    case '!=':
      return not(equals(spec, value));
    case '~':
    case '!~': {
      const text = value.kind === 'literal' ? value.value : value.id;
      const match =
        clause.field === 'text'
          ? { multi_match: { query: text, fields: ['summary^3', 'description'] } }
          : { match: { [spec.es]: { query: text, operator: 'and' } } };
      return clause.operator === '~' ? match : not(match);
    }
    case '>':
    case '<':
    case '>=':
    case '<=': {
      const bound = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' }[clause.operator];
      const raw = value.kind === 'literal' ? value.value : value.id;
      const comparable = spec.type === 'number' ? Number(raw) : spec.type === 'date' ? dateValue(raw) : raw;
      if (spec.type === 'number' && Number.isNaN(comparable)) {
        throw new JQLSyntaxError(`"${raw}" is not a number`);
      }
      return { range: { [spec.es]: { [bound]: comparable } } };
    }
    default:
      throw new JQLSyntaxError(`Unsupported operator ${clause.operator}`);
  }
}

/**
 * JQL parser facade: parse once, translate per request (functions resolve at translation
 * time, so a saved filter using currentUser() is correct for whoever runs it).
 */
export class JQLParser {
  /** Parses a full query, including ORDER BY. */
  parseQuery(jql: string): JQLQuery {
    return new Parser(tokenize(jql), jql.length).parseQuery();
  }

  /** Parses the filter part only; an empty query becomes an empty AND group. */
  parse(jql: string): JQLNode {
    return this.parseQuery(jql).where ?? { type: 'group', logical: 'AND', clauses: [] };
  }

  /** Translates an AST node into an Elasticsearch query. */
  toElasticsearch(ast: JQLNode, context: JQLContext = {}): Record<string, unknown> {
    switch (ast.type) {
      case 'group': {
        const children = ast.clauses.map((child) => this.toElasticsearch(child, context));
        return ast.logical === 'AND'
          ? { bool: { must: children } }
          : { bool: { should: children, minimum_should_match: 1 } };
      }
      case 'not':
        return not(this.toElasticsearch(ast.operand, context));
      case 'clause':
        return clauseToElasticsearch(ast, context);
    }
  }

  /** Translates ORDER BY into an Elasticsearch sort list. */
  toElasticsearchSort(orderBy: JQLSort[]): Record<string, unknown>[] {
    return orderBy.map(({ field, direction }) => {
      const spec = specFor(field);
      if (spec.type === 'text' && !spec.exact) {
        throw new JQLSyntaxError(`Cannot sort by ${field}`);
      }
      const sortField = spec.type === 'text' ? spec.exact! : spec.es;
      return { [sortField]: { order: direction } };
    });
  }
}

/**
 * Singleton JQL parser instance for convenience.
 */
export const jqlParser = new JQLParser();
