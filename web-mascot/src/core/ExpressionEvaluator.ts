type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "eof"; value?: never };

type Reference = { value: unknown; receiver: unknown };

const FORBIDDEN_PROPERTIES = new Set(["__proto__", "prototype", "constructor", "call", "apply", "bind"]);

/** JavaScript forbids mixing ?? with ||/&& at the same parenthesis depth. */
function validateLogicalOperators(tokens: Token[]): void {
  const state = new Map<number, { nullish: boolean; logical: boolean }>();
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== "operator") continue;
    if (token.value === "(") {
      depth++;
      continue;
    }
    if (token.value === ")") {
      depth--;
      continue;
    }
    if (token.value !== "??" && token.value !== "||" && token.value !== "&&") continue;
    const current = state.get(depth) ?? { nullish: false, logical: false };
    if (token.value === "??") current.nullish = true;
    else current.logical = true;
    if (current.nullish && current.logical) {
      throw new SyntaxError("cannot mix ?? with || or && without parentheses");
    }
    state.set(depth, current);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = source.slice(index).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error("invalid number");
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new Error("invalid number");
      tokens.push({ kind: "number", value });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)!;
      tokens.push({ kind: "identifier", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let value = "";
      index++;
      let closed = false;
      while (index < source.length) {
        const current = source[index++]!;
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index++];
          if (escaped === undefined) break;
          value += escaped;
        } else {
          value += current;
        }
      }
      if (!closed) throw new Error("unterminated string");
      tokens.push({ kind: "string", value });
      continue;
    }
    const operator = source.slice(index).match(/^(===|!==|==|!=|<=|>=|&&|\|\||\?\?|[()+\-*/%!?<>=.,:])/);
    if (!operator) throw new Error(`unsupported token '${char}'`);
    tokens.push({ kind: "operator", value: operator[0] });
    index += operator[0].length;
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly scope: Record<string, unknown>;

  constructor(tokens: Token[], scope: Record<string, unknown>) {
    this.tokens = tokens;
    this.scope = scope;
  }

  public parse(): unknown {
    const value = this.conditional();
    if (this.peek().kind !== "eof") throw new Error("unexpected token");
    return value;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(value?: string): Token {
    const token = this.peek();
    if (value !== undefined && (token.kind !== "operator" || token.value !== value)) {
      throw new Error(`expected '${value}'`);
    }
    this.index++;
    return token;
  }

  private conditional(evaluate = true): unknown {
    const condition = this.logicalOr(evaluate);
    if (this.peek().kind !== "operator" || this.peek().value !== "?") return condition;
    this.take("?");
    const whenTrue = this.conditional(evaluate && Boolean(condition));
    this.take(":");
    const whenFalse = this.conditional(evaluate && !Boolean(condition));
    return evaluate ? (condition ? whenTrue : whenFalse) : undefined;
  }

  private logicalOr(evaluate = true): unknown {
    let value = this.logicalAnd(evaluate);
    while (this.peek().kind === "operator" && this.peek().value === "||") {
      this.take("||");
      const shortCircuited = evaluate && Boolean(value);
      const right = this.logicalAnd(evaluate && !shortCircuited);
      value = evaluate ? (shortCircuited ? value : right) : undefined;
    }
    while (this.peek().kind === "operator" && this.peek().value === "??") {
      this.take("??");
      const right = this.logicalAnd(evaluate && value === null);
      value = evaluate ? (value === null || value === undefined ? right : value) : undefined;
    }
    return value;
  }

  private logicalAnd(evaluate = true): unknown {
    let value = this.equality(evaluate);
    while (this.peek().kind === "operator" && this.peek().value === "&&") {
      this.take("&&");
      const shortCircuited = evaluate && !Boolean(value);
      const right = this.equality(evaluate && !shortCircuited);
      value = evaluate ? (shortCircuited ? value : right) : undefined;
    }
    return value;
  }

  private equality(evaluate = true): unknown {
    let value = this.comparison(evaluate);
    while (this.peek().kind === "operator" && ["===", "!==", "==", "!="].includes(this.peek().value as string)) {
      const operator = this.take().value as string;
      const right = this.comparison(evaluate);
      if (evaluate) {
        const equal = operator === "===" || operator === "!=="
          ? value === right
          : value === right || (value == null && right == null) || String(value) === String(right);
        value = operator === "!=" || operator === "!==" ? !equal : equal;
      }
    }
    return value;
  }

  private comparison(evaluate = true): unknown {
    let value = this.additive(evaluate);
    while (this.peek().kind === "operator" && ["<", "<=", ">", ">="].includes(this.peek().value as string)) {
      const operator = this.take().value as string;
      const right = this.additive(evaluate);
      if (!evaluate) continue;
      switch (operator) {
        case "<": value = (value as number) < (right as number); break;
        case "<=": value = (value as number) <= (right as number); break;
        case ">": value = (value as number) > (right as number); break;
        default: value = (value as number) >= (right as number); break;
      }
    }
    return value;
  }

  private additive(evaluate = true): unknown {
    let value = this.multiplicative(evaluate);
    while (this.peek().kind === "operator" && ["+", "-"].includes(this.peek().value as string)) {
      const operator = this.take().value as string;
      const right = this.multiplicative(evaluate);
      if (evaluate) value = operator === "+" ? (value as number) + (right as number) : (value as number) - (right as number);
    }
    return value;
  }

  private multiplicative(evaluate = true): unknown {
    let value = this.unary(evaluate);
    while (this.peek().kind === "operator" && ["*", "/", "%"].includes(this.peek().value as string)) {
      const operator = this.take().value as string;
      const right = this.unary(evaluate);
      if (!evaluate) continue;
      if (operator === "*") value = (value as number) * (right as number);
      else if (operator === "/") value = (value as number) / (right as number);
      else value = (value as number) % (right as number);
    }
    return value;
  }

  private unary(evaluate = true): unknown {
    if (this.peek().kind === "operator" && ["!", "+", "-"].includes(this.peek().value as string)) {
      const operator = this.take().value as string;
      const value = this.unary(evaluate);
      if (!evaluate) return undefined;
      if (operator === "!") return !value;
      return operator === "+" ? +(value as number) : -(value as number);
    }
    return this.postfix(evaluate).value;
  }

  private postfix(evaluate = true): Reference {
    let reference = this.primary(evaluate);
    while (true) {
      if (this.peek().kind === "operator" && this.peek().value === ".") {
        this.take(".");
        const property = this.take();
        if (property.kind !== "identifier") throw new Error("expected property");
        reference = { value: evaluate ? this.readProperty(reference.value, property.value) : undefined, receiver: reference.value };
        continue;
      }
      if (this.peek().kind === "operator" && this.peek().value === "(") {
        this.take("(");
        const args: unknown[] = [];
        if (!(this.peek().kind === "operator" && this.peek().value === ")")) {
          do {
            args.push(this.conditional(evaluate));
            if (!(this.peek().kind === "operator" && this.peek().value === ",")) break;
            this.take(",");
          } while (true);
        }
        this.take(")");
        if (!evaluate) {
          reference = { value: undefined, receiver: undefined };
          continue;
        }
        if (typeof reference.value !== "function") throw new Error("value is not callable");
        reference = { value: reference.value.apply(reference.receiver, args), receiver: undefined };
        continue;
      }
      return reference;
    }
  }

  private primary(evaluate = true): Reference {
    const token = this.take();
    if (token.kind === "number" || token.kind === "string") return { value: token.value, receiver: undefined };
    if (token.kind === "identifier") {
      if (token.value === "true") return { value: true, receiver: undefined };
      if (token.value === "false") return { value: false, receiver: undefined };
      if (token.value === "null") return { value: null, receiver: undefined };
      if (token.value === "undefined") return { value: undefined, receiver: undefined };
      if (token.value === "typeof") {
        const value = this.unary(evaluate);
        return { value: evaluate ? typeof value : undefined, receiver: undefined };
      }
      if (!evaluate) return { value: undefined, receiver: undefined };
      if (!(token.value in this.scope)) throw new Error(`unknown identifier '${token.value}'`);
      return { value: evaluate ? this.scope[token.value] : undefined, receiver: undefined };
    }
    if (token.kind === "operator" && token.value === "(") {
      const value = this.conditional(evaluate);
      this.take(")");
      return { value, receiver: undefined };
    }
    throw new Error("expected value");
  }

  /** Only own properties are exposed; prototype members are intentionally sandboxed. */
  private readProperty(target: unknown, property: string): unknown {
    if (FORBIDDEN_PROPERTIES.has(property) || target === null || target === undefined) {
      throw new Error("property access denied");
    }
    if (
      (typeof target !== "object" && typeof target !== "function") ||
      !Object.prototype.hasOwnProperty.call(target, property)
    ) {
      throw new Error(`unknown property '${property}'`);
    }
    return (target as Record<string, unknown>)[property];
  }
}

export function evaluateExpression(expression: string, scope: Record<string, unknown>): unknown {
  const tokens = tokenize(expression);
  validateLogicalOperators(tokens);
  return new Parser(tokens, scope).parse();
}
