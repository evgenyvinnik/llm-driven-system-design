import { describe, expect, it } from 'vitest';
import { JQLParser, JQLSyntaxError } from './jqlParser.js';

const parser = new JQLParser();
const toES = (jql: string, currentUserId = 'u-1') =>
  parser.toElasticsearch(parser.parse(jql), { currentUserId, now: new Date('2026-10-07T15:30:00Z') });

describe('JQL parsing', () => {
  it('binds AND tighter than OR', () => {
    const ast = parser.parse('status = Done OR status = "In Progress" AND project = DEMO');
    expect(ast).toEqual({
      type: 'group',
      logical: 'OR',
      clauses: [
        { type: 'clause', field: 'status', operator: '=', value: 'Done' },
        {
          type: 'group',
          logical: 'AND',
          clauses: [
            { type: 'clause', field: 'status', operator: '=', value: 'In Progress' },
            { type: 'clause', field: 'project', operator: '=', value: 'DEMO' },
          ],
        },
      ],
    });
  });

  it('lets parentheses override precedence', () => {
    const ast = parser.parse('(status = Done OR status = Open) AND project = DEMO');
    expect(ast.type === 'group' && ast.logical).toBe('AND');
  });

  it('parses NOT, IN lists, IS EMPTY and functions', () => {
    const ast = parser.parse('NOT priority IN (high, "highest") AND assignee IS EMPTY AND reporter = currentUser()');
    expect(ast).toEqual({
      type: 'group',
      logical: 'AND',
      clauses: [
        { type: 'not', operand: { type: 'clause', field: 'priority', operator: 'IN', value: ['high', 'highest'] } },
        { type: 'clause', field: 'assignee', operator: 'IS', value: null },
        { type: 'clause', field: 'reporter', operator: '=', value: { type: 'function', name: 'currentuser', args: [] } },
      ],
    });
  });

  it('treats keywords case-insensitively and canonicalizes field aliases', () => {
    const ast = parser.parse('issuetype = Bug and Labels not in (ui)');
    expect(ast).toEqual({
      type: 'group',
      logical: 'AND',
      clauses: [
        { type: 'clause', field: 'type', operator: '=', value: 'Bug' },
        { type: 'clause', field: 'labels', operator: 'NOT IN', value: ['ui'] },
      ],
    });
  });

  it('parses ORDER BY with directions', () => {
    const query = parser.parseQuery('project = DEMO ORDER BY priority DESC, created');
    expect(query.orderBy).toEqual([
      { field: 'priority', direction: 'desc' },
      { field: 'created', direction: 'asc' },
    ]);
    expect(parser.parseQuery('ORDER BY updated DESC').where).toBeNull();
  });

  it.each([
    ['project = DEMO status = Done', /Unexpected "status"/],
    ['(project = DEMO', /Expected "\)"/],
    ['project = DEMO AND', /Expected a field name but the query ended/],
    ['project = "DEMO', /Unterminated string/],
    ['nonsense = 1', /Unknown field "nonsense"/],
    ['status > Done', /Operator > is not supported for status/],
    ['priority IN high', /IN needs a list/],
    ['assignee IS someone', /must be followed by EMPTY or NULL/],
    ['assignee = whoAmI()', /Unknown function/],
    ['project = DEMO ORDER priority', /Expected BY after ORDER/],
  ])('rejects %s', (jql, message) => {
    expect(() => parser.parseQuery(jql)).toThrow(JQLSyntaxError);
    expect(() => parser.parseQuery(jql)).toThrow(message);
  });
});

describe('JQL to Elasticsearch', () => {
  it('compares currentUser() against the id field, not the display name', () => {
    expect(toES('assignee = currentUser()')).toEqual({ term: { assignee_id: 'u-1' } });
  });

  it('matches keyword values case-insensitively', () => {
    expect(toES('status = "in progress"')).toEqual({
      term: { status: { value: 'in progress', case_insensitive: true } },
    });
  });

  it('translates OR groups, NOT and IN lists', () => {
    expect(toES('status = Done OR NOT type IN (bug, task)')).toEqual({
      bool: {
        should: [
          { term: { status: { value: 'Done', case_insensitive: true } } },
          {
            bool: {
              must_not: [
                {
                  bool: {
                    should: [
                      { term: { issue_type: { value: 'bug', case_insensitive: true } } },
                      { term: { issue_type: { value: 'task', case_insensitive: true } } },
                    ],
                    minimum_should_match: 1,
                  },
                },
              ],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it('uses exists checks for EMPTY', () => {
    expect(toES('assignee IS EMPTY')).toEqual({ bool: { must_not: [{ exists: { field: 'assignee_name' } }] } });
    expect(toES('sprint IS NOT EMPTY')).toEqual({ exists: { field: 'sprint_name' } });
  });

  it('builds numeric, date and relative-date ranges', () => {
    expect(toES('storyPoints >= 5')).toEqual({ range: { story_points: { gte: 5 } } });
    expect(toES('created > -7d')).toEqual({ range: { created_at: { gt: 'now-7d' } } });
    expect(toES('updated < startOfDay()')).toEqual({ range: { updated_at: { lt: '2026-10-07T00:00:00.000Z' } } });
    expect(() => toES('storyPoints > many')).toThrow(/not a number/);
  });

  it('searches text fields with match and the text pseudo-field across fields', () => {
    expect(toES('summary ~ "login crash"')).toEqual({
      match: { summary: { query: 'login crash', operator: 'and' } },
    });
    expect(toES('text ~ crash')).toEqual({
      multi_match: { query: 'crash', fields: ['summary^3', 'description'] },
    });
    expect(() => toES('description = "exact"')).toThrow(/Use ~/);
  });

  it('translates ORDER BY into an Elasticsearch sort', () => {
    const { orderBy } = parser.parseQuery('ORDER BY summary ASC, priority DESC');
    expect(parser.toElasticsearchSort(orderBy)).toEqual([
      { 'summary.keyword': { order: 'asc' } },
      { priority: { order: 'desc' } },
    ]);
  });
});
