type Matcher = string | RegExp | ((ch: string) => boolean);

function countColumn(text: string, end: number, tabSize: number): number {
  let column = 0;
  for (let i = 0; i < end; i++) {
    column = text.charCodeAt(i) === 9 ? column + tabSize - (column % tabSize) : column + 1;
  }
  return column;
}

/** The CodeMirror 5 token stream the vim engine uses to parse ex commands. */
export class StringStream {
  pos = 0;
  start = 0;

  constructor(
    public string: string,
    private readonly tabSize = 4,
  ) {}

  eol(): boolean {
    return this.pos >= this.string.length;
  }

  sol(): boolean {
    return this.pos === 0;
  }

  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }

  next(): string | undefined {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
    return undefined;
  }

  eat(match: Matcher): string | undefined {
    const ch = this.string.charAt(this.pos);
    const ok =
      typeof match === "string"
        ? ch === match
        : ch !== "" && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (!ok) return undefined;
    this.pos++;
    return ch;
  }

  eatWhile(match: Matcher): boolean {
    const start = this.pos;
    while (this.eat(match)) {}
    return this.pos > start;
  }

  eatSpace(): boolean {
    const start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  skipToEnd(): void {
    this.pos = this.string.length;
  }

  skipTo(ch: string): boolean | undefined {
    const found = this.string.indexOf(ch, this.pos);
    if (found === -1) return undefined;
    this.pos = found;
    return true;
  }

  backUp(n: number): void {
    this.pos -= n;
  }

  column(): number {
    return countColumn(this.string, this.start, this.tabSize);
  }

  indentation(): number {
    const indent = /^\s*/.exec(this.string)![0].length;
    return countColumn(this.string, indent, this.tabSize);
  }

  match(
    pattern: string | RegExp,
    consume?: boolean,
    caseInsensitive?: boolean,
  ): boolean | RegExpMatchArray | null {
    if (typeof pattern === "string") {
      const cased = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
      const candidate = this.string.substr(this.pos, pattern.length);
      if (cased(candidate) !== cased(pattern)) return null;
      if (consume !== false) this.pos += pattern.length;
      return true;
    }
    const match = this.string.slice(this.pos).match(pattern);
    if (match && match.index! > 0) return null;
    if (match && consume !== false) this.pos += match[0].length;
    return match;
  }

  current(): string {
    return this.string.slice(this.start, this.pos);
  }
}
