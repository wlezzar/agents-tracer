// Building the DOM: every text reaches it through textContent or a text node, and every value
// through an attribute, never through HTML.

/** What an element can hold: nodes, texts, numbers; nothing for null, undefined, or false. */
export type Child = Node | string | number | null | undefined | false;

/** An element's attributes: `class`, `text` (its text), `style` (its CSS), `onclick`, and any other attribute. */
export interface Attrs {
  readonly class?: string;
  readonly text?: string;
  readonly style?: string;
  readonly onclick?: (event: MouseEvent) => void;
  readonly [name: string]: string | number | boolean | null | undefined | ((event: MouseEvent) => void);
}

/** A new element with `attrs`, then `kids` (arrays one level deep) appended. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...kids: (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') {
      if (k.startsWith('on'))
        n.addEventListener(k.slice(2), (e) => {
          if (e instanceof MouseEvent) v(e);
        });
    } else if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'style') n.style.cssText = String(v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat())
    if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

/** The element with `id`, which must be of `type`. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const n = document.getElementById(id);
  if (!(n instanceof type)) throw new Error(`the viewer has no #${id} ${type.name}`);
  return n;
}

/** The first element `selector` matches, which must be of `type`. */
export function query<T extends Element>(selector: string, type: new () => T): T {
  const n = document.querySelector(selector);
  if (!(n instanceof type)) throw new Error(`the viewer has no ${selector} ${type.name}`);
  return n;
}

/** Every element `selector` matches that is of `type`. */
export function queryAll<T extends Element>(selector: string, type: new () => T, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(selector)].filter((n): n is T => n instanceof type);
}

/** Children as replaceChildren takes them: nodes and texts, without the ones that are nothing. */
export function nodes(kids: readonly Child[]): (Node | string)[] {
  return kids.flatMap((c) => (c == null || c === false ? [] : [c instanceof Node ? c : String(c)]));
}

/** The values, without the ones that are nothing. */
export function present<T>(values: readonly (T | null | undefined | false)[]): T[] {
  return values.filter((v): v is T => v != null && v !== false);
}

/** A button that copies `text` to the clipboard, and says whether it did. */
export function copyButton(text: string): HTMLButtonElement {
  const button = el('button', { type: 'button' }, 'Copy');
  button.addEventListener('click', () => {
    const copied = (async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    })();
    void copied;
  });
  return button;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A new SVG element with its attributes, then `kids` appended. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
  ...kids: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of kids) n.append(c);
  return n;
}
