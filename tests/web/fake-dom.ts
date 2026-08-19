/**
 * Minimal DOM stand-in for the dashboard's render functions.
 *
 * The dashboard renders with `innerHTML` against a fixed set of element ids
 * (there is no framework), so a map of fake nodes is enough to drive a real
 * render and inspect what comes out. Shared by the render tests rather than
 * copied into each, so they all exercise the same stand-in.
 */

export interface FakeElement {
  id: string;
  innerHTML: string;
  textContent: string;
  className: string;
  checked: boolean;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    toggle: (name: string, force?: boolean) => void;
    contains: (name: string) => boolean;
  };
}

export const elements = new Map<string, FakeElement>();

export function makeElement(id: string): FakeElement {
  const classes = new Set<string>();
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

/**
 * `instanceof` checks in `renderControls` need these to exist. Nothing is ever
 * an instance of them, so those branches simply skip — the charts are what
 * these tests are about.
 */
const DOM_GLOBALS = [
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
] as const;

/**
 * Installs the stand-in. `selected` supplies the nodes `querySelectorAll`
 * returns, keyed by selector — the metric tabs are the only markup the render
 * functions reach for that way.
 */
export function installFakeDom(selected: Record<string, FakeElement[]> = {}): void {
  elements.clear();
  for (const name of DOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[name] = class {};
  }
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string): FakeElement => {
      let node = elements.get(id);
      if (node === undefined) {
        node = makeElement(id);
        elements.set(id, node);
      }
      return node;
    },
    querySelectorAll: (selector: string): FakeElement[] => selected[selector] ?? [],
  };
}

export function uninstallFakeDom(): void {
  delete (globalThis as unknown as { document?: unknown }).document;
  for (const name of DOM_GLOBALS) {
    delete (globalThis as unknown as Record<string, unknown>)[name];
  }
}
