// An in-memory stand-in for expo-file-system's File / Directory / Paths, enough
// for the attachment cache and queue: files are a map from URI to size and
// modification time, directories a set of URIs.

export interface FakeFile {
  size: number;
  mtime: number;
  /** Contents, for a file written as text. */
  text?: string;
}

export interface FakeFileSystem {
  files: Map<string, FakeFile>;
  dirs: Set<string>;
  /** `File.downloadFileAsync(url, destination)`: writes what it resolves to. */
  download: jest.Mock<Promise<FakeFile>, [string]>;
  /** Set to make the next `move` throw. */
  failNextMove: { value: boolean };
  now: { value: number };
  /** How many times a directory was listed (walks of the cache). */
  listCalls: { value: number };
  module: Record<string, unknown>;
}

export function createFakeFileSystem(root = "file:///docs"): FakeFileSystem {
  const files = new Map<string, FakeFile>();
  const dirs = new Set<string>([root]);
  const download = jest.fn<Promise<FakeFile>, [string]>();
  const failNextMove = { value: false };
  const now = { value: 1_000 };
  const listCalls = { value: 0 };

  const toUri = (parts: unknown[]): string =>
    parts
      .map((part, index) => {
        const text = typeof part === "string" ? part : (part as { uri: string }).uri;
        const trimmed = text.replace(/\/+$/, "");
        return index === 0 ? trimmed : trimmed.replace(/^\/+/, "");
      })
      .join("/");

  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf("/"));
  const nameOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = toUri(parts);
    }
    get name() {
      return nameOf(this.uri);
    }
    get exists() {
      return dirs.has(this.uri) || [...files.keys()].some((key) => key.startsWith(`${this.uri}/`));
    }
    create() {
      let uri = this.uri;
      while (uri.length > root.length) {
        dirs.add(uri);
        uri = parentOf(uri);
      }
    }
    delete() {
      for (const key of [...files.keys()]) if (key.startsWith(`${this.uri}/`)) files.delete(key);
      for (const key of [...dirs])
        if (key === this.uri || key.startsWith(`${this.uri}/`)) dirs.delete(key);
    }
    list() {
      listCalls.value += 1;
      const children = new Map<string, Directory | File>();
      const prefix = `${this.uri}/`;
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [first, ...more] = rest.split("/");
        const uri = `${prefix}${first}`;
        if (children.has(uri)) continue;
        children.set(uri, more.length > 0 || dirs.has(uri) ? new Directory(uri) : new File(uri));
      }
      return [...children.values()];
    }
  }

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = toUri(parts);
    }
    get name() {
      return nameOf(this.uri);
    }
    get parentDirectory() {
      return new Directory(parentOf(this.uri));
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return files.get(this.uri)?.size ?? 0;
    }
    get modificationTime() {
      return files.get(this.uri)?.mtime ?? null;
    }
    delete() {
      if (!files.delete(this.uri)) throw new Error(`no file ${this.uri}`);
    }
    create() {
      files.set(this.uri, { size: 0, mtime: now.value });
    }
    write(content: string) {
      files.set(this.uri, { size: content.length, mtime: now.value, text: content });
    }
    textSync() {
      return files.get(this.uri)?.text ?? "";
    }
    copy(destination: File) {
      const file = files.get(this.uri);
      if (!file) throw new Error(`no file ${this.uri}`);
      files.set(destination.uri, { size: file.size, mtime: now.value });
    }
    move(destination: File) {
      if (failNextMove.value) {
        failNextMove.value = false;
        throw new Error("move failed");
      }
      const file = files.get(this.uri);
      if (!file) throw new Error(`no file ${this.uri}`);
      files.delete(this.uri);
      files.set(destination.uri, file);
      this.uri = destination.uri;
    }
    static async downloadFileAsync(url: string, destination: File) {
      const file = await download(url);
      files.set(destination.uri, file);
      return destination;
    }
  }

  return {
    files,
    dirs,
    download,
    failNextMove,
    now,
    listCalls,
    module: { File, Directory, Paths: { document: new Directory(root) } },
  };
}

/**
 * One fake per test file (each file has its own module registry). Mock
 * expo-file-system with it from a factory, which can't close over test-file
 * variables:
 *   jest.mock("expo-file-system", () => require("../helpers/fake-expo-file-system").fakeFs.module);
 */
export const fakeFs = createFakeFileSystem();

/** Empty the fake between tests. */
export function resetFakeFs(): void {
  fakeFs.files.clear();
  fakeFs.dirs.clear();
  fakeFs.dirs.add("file:///docs");
  fakeFs.download.mockReset();
  fakeFs.failNextMove.value = false;
  fakeFs.now.value = 1_000;
  fakeFs.listCalls.value = 0;
}
