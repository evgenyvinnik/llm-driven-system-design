// JQL (Jira Query Language) Parser
// Supports queries like: project = DEMO AND status = "In Progress" AND assignee = currentUser()

export type JQLOperator = '=' | '!=' | '~' | '!~' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT IN' | 'IS' | 'IS NOT';
export type JQLLogical = 'AND' | 'OR';

export interface JQLClause {
  type: 'clause';
  field: string;
  operator: JQLOperator;
  value: JQLValue;
}

export interface JQLGroup {
  type: 'group';
  logical: JQLLogical;
  clauses: JQLNode[];
}

export type JQLNode = JQLClause | JQLGroup;

export type JQLValue = string | number | boolean | null | string[] | JQLFunction;

export interface JQLFunction {
  type: 'function';
  name: string;
  args: string[];
}

interface Token {
  type: 'field' | 'operator' | 'value' | 'logical' | 'lparen' | 'rparen' | 'function' | 'comma';
  value: string;
}

const OPERATORS: Record<string, JQLOperator> = {
  '=': '=',
  '!=': '!=',
  '~': '~',
  '!~': '!~',
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  'in': 'IN',
  'not in': 'NOT IN',
  'is': 'IS',
  'is not': 'IS NOT',
};

const FIELDS = [
  'project', 'status', 'assignee', 'reporter', 'priority', 'type', 'issuetype',
  'sprint', 'epic', 'labels', 'component', 'summary', 'description', 'key',
  'created', 'updated', 'storypoints', 'story_points'
];

const FUNCTIONS = ['currentUser', 'now', 'startOfDay', 'endOfDay', 'startOfWeek', 'endOfWeek', 'empty', 'null'];

export class JQLParser {
  private tokens: Token[] = [];
  private position = 0;

  parse(jql: string): JQLNode {
    this.tokens = this.tokenize(jql);
    this.position = 0;

    if (this.tokens.length === 0) {
      return { type: 'group', logical: 'AND', clauses: [] };
    }

    return this.parseExpression();
  }

  private tokenize(jql: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const input = jql.trim();

    while (i < input.length) {
      // Skip whitespace
      if (/\s/.test(input[i])) {
        i++;
        continue;
      }

      // Parentheses
      if (input[i] === '(') {
        tokens.push({ type: 'lparen', value: '(' });
        i++;
        continue;
      }
      if (input[i] === ')') {
        tokens.push({ type: 'rparen', value: ')' });
        i++;
        continue;
      }

      // Comma
      if (input[i] === ',') {
        tokens.push({ type: 'comma', value: ',' });
        i++;
        continue;
      }

      // Multi-character operators
      const twoChar = input.substring(i, i + 2);
      if (['!=', '>=', '<=', '!~'].includes(twoChar)) {
        tokens.push({ type: 'operator', value: twoChar });
        i += 2;
        continue;
      }

      // Single-character operators
      if (['=', '>', '<', '~'].includes(input[i])) {
        tokens.push({ type: 'operator', value: input[i] });
        i++;
        continue;
      }

      // Quoted string
      if (input[i] === '"' || input[i] === "'") {
        const quote = input[i];
        i++;
        let value = '';
        while (i < input.length && input[i] !== quote) {
          if (input[i] === '\\' && i + 1 < input.length) {
            i++;
          }
          value += input[i];
          i++;
        }
        i++; // Skip closing quote
        tokens.push({ type: 'value', value });
        continue;
      }

      // Word (field, operator keyword, value, function, or logical)
      let word = '';
      while (i < input.length && /[a-zA-Z0-9_\-.]/.test(input[i])) {
        word += input[i];
        i++;
      }

      if (word) {
        const lowerWord = word.toLowerCase();

        // Check for "NOT IN" (two words)
        if (lowerWord === 'not') {
          // Look ahead for 'in'
          let j = i;
          while (j < input.length && /\s/.test(input[j])) j++;
          const nextWord = input.substring(j).match(/^in\b/i);
          if (nextWord) {
            tokens.push({ type: 'operator', value: 'NOT IN' });
            i = j + 2;
            continue;
          }
        }

        // Check for "IS NOT" (two words)
        if (lowerWord === 'is') {
          let j = i;
          while (j < input.length && /\s/.test(input[j])) j++;
          const nextWord = input.substring(j).match(/^not\b/i);
          if (nextWord) {
            tokens.push({ type: 'operator', value: 'IS NOT' });
            i = j + 3;
            continue;
          }
          tokens.push({ type: 'operator', value: 'IS' });
          continue;
        }

        // Logical operators
        if (lowerWord === 'and' || lowerWord === 'or') {
          tokens.push({ type: 'logical', value: lowerWord.toUpperCase() });
          continue;
        }

        // Operators
        if (lowerWord === 'in') {
          tokens.push({ type: 'operator', value: 'IN' });
          continue;
        }

        // Functions (word followed by parentheses)
        if (input[i] === '(' && FUNCTIONS.some(f => f.toLowerCase() === lowerWord)) {
          tokens.push({ type: 'function', value: word });
          continue;
        }

        // Fields
        if (FIELDS.includes(lowerWord)) {
          tokens.push({ type: 'field', value: lowerWord });
          continue;
        }

        // Custom field (cf[xxx])
        if (lowerWord === 'cf' && input[i] === '[') {
          i++; // skip [
          let cfId = '';
          while (i < input.length && input[i] !== ']') {
            cfId += input[i];
            i++;
          }
          i++; // skip ]
          tokens.push({ type: 'field', value: `cf_${cfId}` });
          continue;
        }

        // Otherwise it's a value
        tokens.push({ type: 'value', value: word });
      }
    }

    return tokens;
  }

  private parseExpression(): JQLNode {
    let left = this.parsePrimary();

    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];

      if (token.type === 'logical') {
        const logical = token.value as JQLLogical;
        this.position++;
        const right = this.parsePrimary();

        if (left.type === 'group' && left.logical === logical) {
          left.clauses.push(right);
        } else {
          left = {
            type: 'group',
            logical,
            clauses: [left, right],
          };
        }
      } else {
        break;
      }
    }

    return left;
  }

  private parsePrimary(): JQLNode {
    const token = this.tokens[this.position];

    if (token?.type === 'lparen') {
      this.position++;
      const expr = this.parseExpression();
      if (this.tokens[this.position]?.type === 'rparen') {
        this.position++;
      }
      return expr;
    }

    return this.parseClause();
  }

  private parseClause(): JQLClause {
    const fieldToken = this.tokens[this.position++];
    if (!fieldToken || fieldToken.type !== 'field') {
      throw new Error(`Expected field, got: ${fieldToken?.value}`);
    }

    const operatorToken = this.tokens[this.position++];
    if (!operatorToken || operatorToken.type !== 'operator') {
      throw new Error(`Expected operator, got: ${operatorToken?.value}`);
    }

    const value = this.parseValue();

    return {
      type: 'clause',
      field: this.normalizeField(fieldToken.value),
      operator: operatorToken.value as JQLOperator,
      value,
    };
  }

  private parseValue(): JQLValue {
    const token = this.tokens[this.position];

    if (!token) {
      throw new Error('Expected value');
    }

    // Function
    if (token.type === 'function') {
      this.position++;
      const funcName = token.value;
      const args: string[] = [];

      // Skip lparen
      if (this.tokens[this.position]?.type === 'lparen') {
        this.position++;
      }

      // Parse arguments
      while (this.tokens[this.position] && this.tokens[this.position].type !== 'rparen') {
        if (this.tokens[this.position].type === 'comma') {
          this.position++;
          continue;
        }
        args.push(this.tokens[this.position].value);
        this.position++;
      }

      // Skip rparen
      if (this.tokens[this.position]?.type === 'rparen') {
        this.position++;
      }

      return { type: 'function', name: funcName, args };
    }

    // List (for IN operator)
    if (token.type === 'lparen') {
      this.position++;
      const values: string[] = [];

      while (this.tokens[this.position] && this.tokens[this.position].type !== 'rparen') {
        if (this.tokens[this.position].type === 'comma') {
          this.position++;
          continue;
        }
        values.push(this.tokens[this.position].value);
        this.position++;
      }

      if (this.tokens[this.position]?.type === 'rparen') {
        this.position++;
      }

      return values;
    }

    // Single value
    this.position++;

    // Check for special values
    const lowerValue = token.value.toLowerCase();
    if (lowerValue === 'empty' || lowerValue === 'null') {
      return null;
    }
    if (lowerValue === 'true') return true;
    if (lowerValue === 'false') return false;

    // Try to parse as number
    const num = Number(token.value);
    if (!isNaN(num)) return num;

    return token.value;
  }

  private normalizeField(field: string): string {
    const fieldMap: Record<string, string> = {
      'type': 'issue_type',
      'issuetype': 'issue_type',
      'storypoints': 'story_points',
      'component': 'components',
    };
    return fieldMap[field] || field;
  }

  // Convert JQL AST to Elasticsearch query
  toElasticsearch(ast: JQLNode, context: { currentUserId?: string } = {}): Record<string, unknown> {
    if (ast.type === 'group') {
      const esClauseList = ast.clauses.map(c => this.toElasticsearch(c, context));

      if (ast.logical === 'AND') {
        return { bool: { must: esClauseList } };
      } else {
        return { bool: { should: esClauseList, minimum_should_match: 1 } };
      }
    }

    return this.clauseToES(ast as JQLClause, context);
  }

  private clauseToES(clause: JQLClause, context: { currentUserId?: string }): Record<string, unknown> {
    const field = this.esFieldName(clause.field);
    let value = this.resolveValue(clause.value, context);

    switch (clause.operator) {
      case '=':
        if (value === null) {
          return { bool: { must_not: { exists: { field } } } };
        }
        return { term: { [field]: value } };

      case '!=':
        if (value === null) {
          return { exists: { field } };
        }
        return { bool: { must_not: { term: { [field]: value } } } };

      case '~':
        return { match: { [field]: value } };

      case '!~':
        return { bool: { must_not: { match: { [field]: value } } } };

      case '>':
        return { range: { [field]: { gt: value } } };

      case '<':
        return { range: { [field]: { lt: value } } };

      case '>=':
        return { range: { [field]: { gte: value } } };

      case '<=':
        return { range: { [field]: { lte: value } } };

      case 'IN':
        return { terms: { [field]: value } };

      case 'NOT IN':
        return { bool: { must_not: { terms: { [field]: value } } } };

      case 'IS':
        if (value === null) {
          return { bool: { must_not: { exists: { field } } } };
        }
        return { term: { [field]: value } };

      case 'IS NOT':
        if (value === null) {
          return { exists: { field } };
        }
        return { bool: { must_not: { term: { [field]: value } } } };

      default:
        return { term: { [field]: value } };
    }
  }

  private esFieldName(field: string): string {
    const fieldMap: Record<string, string> = {
      'project': 'project_key',
      'status': 'status',
      'assignee': 'assignee_name',
      'reporter': 'reporter_name',
      'priority': 'priority',
      'issue_type': 'issue_type',
      'sprint': 'sprint_name',
      'epic': 'epic_key',
      'labels': 'labels',
      'components': 'components',
      'summary': 'summary',
      'description': 'description',
      'key': 'key',
      'created': 'created_at',
      'updated': 'updated_at',
      'story_points': 'story_points',
    };
    return fieldMap[field] || field;
  }

  private resolveValue(value: JQLValue, context: { currentUserId?: string }): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value;
    }

    // Handle functions
    if (typeof value === 'object' && value.type === 'function') {
      const funcName = value.name.toLowerCase();

      switch (funcName) {
        case 'currentuser':
          return context.currentUserId || '';

        case 'now':
          return new Date().toISOString();

        case 'startofday':
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          return startOfDay.toISOString();

        case 'endofday':
          const endOfDay = new Date();
          endOfDay.setHours(23, 59, 59, 999);
          return endOfDay.toISOString();

        case 'startofweek':
          const startOfWeek = new Date();
          startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
          startOfWeek.setHours(0, 0, 0, 0);
          return startOfWeek.toISOString();

        case 'endofweek':
          const endOfWeek = new Date();
          endOfWeek.setDate(endOfWeek.getDate() + (6 - endOfWeek.getDay()));
          endOfWeek.setHours(23, 59, 59, 999);
          return endOfWeek.toISOString();

        case 'empty':
        case 'null':
          return null;

        default:
          return null;
      }
    }

    return value;
  }
}

export const jqlParser = new JQLParser();
