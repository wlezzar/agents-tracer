// The types of boundaries.mjs, for the TypeScript tests that read it.

/** What one agent calls its tools, files, and record fields. */
export interface Boundary {
  /** The agent's name, for the messages. */
  readonly agent: string;
  /** What no string literal, template text, or object key outside the adapters may hold. */
  readonly words: RegExp;
  /** Every tool name the adapter knows, which no code outside the adapters may match a value against. */
  readonly tools: readonly string[];
}

export declare const boundaries: Readonly<Record<string, Boundary>>;

/** The no-restricted-syntax entries that keep the adapters' vocabularies out of the code they apply to. */
export declare function boundarySelectors(
  all: Readonly<Record<string, Boundary>>,
): { readonly selector: string; readonly message: string }[];
