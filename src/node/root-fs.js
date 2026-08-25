import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { validateImageUpload } from '../lib/image-upload.js';

const {
  O_RDONLY,
  O_NOFOLLOW,
  O_DIRECTORY,
  O_CLOEXEC,
} = fs.constants;

const ACTIVE_PREVIEW_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([
  '', '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.log', '.go', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.java', '.c', '.h',
  '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.fish', '.sql', '.xml', '.css', '.scss', '.ini', '.cfg',
  '.conf', '.env', '.gitignore', '.dockerfile', '.proto', '.tex', '.r', '.rb', '.php', '.swift',
]);

function within(rootPath, candidate) {
  return candidate === rootPath || candidate.startsWith(`${rootPath}${path.sep}`);
}

function kindFromStat(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice()) return 'character_device';
  if (stat.isBlockDevice()) return 'block_device';
  return 'special';
}

function metadata(name, stat, extra = {}) {
  const kind = kindFromStat(stat);
  return {
    name,
    kind,
    size: stat.isFile() ? Number(stat.size) : undefined,
    mtime: stat.mtime.toISOString(),
    mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
    downloadable: kind === 'file',
    previewable: kind === 'file' && !ACTIVE_PREVIEW_EXTENSIONS.has(path.extname(name).toLowerCase()),
    ...extra,
  };
}

export function validateRelativePath(value, { allowEmpty = true } = {}) {
  invariant(typeof value === 'string', 'WS_PATH_INVALID', 'Path must be a string.');
  invariant(Buffer.byteLength(value, 'utf8') <= 4096, 'WS_PATH_INVALID', 'Path is too long.');
  invariant(!value.includes('\0'), 'WS_PATH_INVALID', 'Path contains a NUL byte.');
  invariant(!value.includes('\\'), 'WS_PATH_INVALID', 'Backslash path separators are not accepted.');
  invariant(!/[\u2044\u2215\u29f8\uff0f]/u.test(value), 'WS_PATH_INVALID', 'Ambiguous Unicode path separator is not accepted.');
  invariant(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value), 'WS_PATH_INVALID', 'Absolute paths are not accepted.');
  if (value === '') {
    invariant(allowEmpty, 'WS_PATH_INVALID', 'A file path is required.');
    return [];
  }
  invariant(!value.startsWith('/') && !value.endsWith('/'), 'WS_PATH_INVALID', 'Path must be normalized and relative.');
  const parts = value.split('/');
  invariant(parts.every((part) => part && part !== '.' && part !== '..'), 'WS_PATH_ESCAPE_BLOCKED', 'Path traversal was blocked.', 403);
  invariant(parts.every((part) => Buffer.byteLength(part, 'utf8') <= 255), 'WS_PATH_INVALID', 'A path component is too long.');
  return parts;
}

export class RootedFileService {
  constructor(rootDefinitions = [], options = {}) {
    this.maxTextPreviewBytes = options.maxTextPreviewBytes ?? 2 * 1024 * 1024;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 64 * 1024 * 1024;
    this.maxSearchMatches = options.maxSearchMatches ?? 5_000;
    this.maxSearchMs = options.maxSearchMs ?? 10_000;
    this.roots = new Map();
    for (const definition of rootDefinitions) this.register(definition);
  }

  register(definition) {
    invariant(definition?.id && definition?.path, 'WS_VALIDATION', 'Root ID and local path are required.');
    invariant(!this.roots.has(definition.id), 'WS_CONFLICT', 'Root ID is already registered.', 409);
    const canonical = fs.realpathSync(definition.path);
    const stat = fs.statSync(canonical);
    invariant(stat.isDirectory(), 'WS_ROOT_NOT_FOUND', 'Configured root is not a directory.', 404);
    const fd = fs.openSync(canonical, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    const procAnchor = `/proc/self/fd/${fd}`;
    let anchor = canonical;
    let usesProc = false;
    try {
      if (fs.realpathSync(procAnchor) === canonical) {
        anchor = procAnchor;
        usesProc = true;
      }
    } catch { /* /proc is intentionally unavailable in some sandboxes */ }
    this.roots.set(definition.id, {
      id: definition.id,
      displayName: definition.display_name || definition.displayName || definition.id,
      configuredPath: definition.path,
      canonical,
      fd,
      anchor,
      device: stat.dev,
      inode: stat.ino,
      usesProc,
      symlinkPolicy: definition.symlink_policy || definition.symlinkPolicy || 'no_symlinks',
      mountPolicy: definition.mount_policy || definition.mountPolicy || 'allow_nested',
      allowDownload: definition.allow_download ?? definition.allowDownload ?? true,
      allowPreview: definition.allow_preview ?? definition.allowPreview ?? true,
      allowSearch: definition.allow_search ?? definition.allowSearch ?? true,
    });
  }

  close() {
    for (const root of this.roots.values()) {
      try { fs.closeSync(root.fd); } catch { /* already closed */ }
    }
    this.roots.clear();
  }

  getRoot(rootId) {
    const root = this.roots.get(rootId);
    invariant(root, 'WS_ROOT_NOT_FOUND', 'Workspace root is unavailable.', 404);
    return root;
  }

  writeInbox(rootId, { documentId, filename, bytes, sha256 }) {
    const root = this.getRoot(rootId);
    invariant(typeof documentId === 'string' && /^doc_[A-Za-z0-9_-]{8,80}$/.test(documentId),
      'WS_VALIDATION', 'A valid document ID is required.');
    invariant(typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(filename)
      && ['.txt', '.md', '.markdown'].includes(path.extname(filename).toLowerCase()),
    'WS_VALIDATION', 'Inbox documents require a safe .txt, .md, or .markdown filename.');
    invariant(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 512 * 1024,
      'WS_REQUEST_TOO_LARGE', 'Inbox document must contain between 1 byte and 512 KiB.', 413);
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      throw new WebSpiderError('WS_VALIDATION', 'Inbox document must be valid UTF-8 text.', 400);
    }
    invariant(!decoded.includes('\0'), 'WS_VALIDATION', 'Inbox documents must be UTF-8 text without NUL bytes.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    invariant(digest === sha256, 'WS_VALIDATION', 'Inbox document checksum does not match.');

    const rootPath = this.#currentRoot(root);
    let directory = root.anchor;
    for (const component of ['.webspider', 'inbox']) {
      directory = path.join(directory, component);
      try {
        const stat = fs.lstatSync(directory);
        invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
          'The reserved WebSpider inbox path is not a real directory.', 403);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      const resolved = fs.realpathSync(directory);
      invariant(within(rootPath, resolved), 'WS_PATH_ESCAPE_BLOCKED', 'Inbox path escaped the workspace root.', 403);
    }

    const storedName = `${documentId}-${filename}`;
    const relativePath = `.webspider/inbox/${storedName}`;
    const destination = path.join(directory, storedName);
    try {
      const stat = fs.lstatSync(destination);
      invariant(stat.isFile() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
        'Inbox destination is not a regular file.', 403);
      const existing = fs.readFileSync(destination);
      invariant(createHash('sha256').update(existing).digest('hex') === digest,
        'WS_CONFLICT', 'Document ID already exists with different content.', 409);
      return { document_id: documentId, relative_path: relativePath, filename, sha256: digest, size_bytes: bytes.length, duplicate: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(directory, `.document-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or already removed */ }
    }
    const resolved = fs.realpathSync(destination);
    invariant(within(rootPath, resolved), 'WS_PATH_ESCAPE_BLOCKED', 'Inbox document escaped the workspace root.', 403);
    return { document_id: documentId, relative_path: relativePath, filename, sha256: digest, size_bytes: bytes.length, duplicate: false };
  }

  writeUserGuide(rootId, bytes) {
    const root = this.getRoot(rootId);
    invariant(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024,
      'WS_REQUEST_TOO_LARGE', 'WebSpider user guide must contain between 1 byte and 1 MiB.', 413);
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      throw new WebSpiderError('WS_VALIDATION', 'WebSpider user guide must be valid UTF-8 text.', 400);
    }
    invariant(!decoded.includes('\0'), 'WS_VALIDATION', 'WebSpider user guide must not contain NUL bytes.');

    const rootPath = this.#currentRoot(root);
    const directory = path.join(root.anchor, '.webspider');
    try {
      const stat = fs.lstatSync(directory);
      invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
        'The reserved WebSpider path is not a real directory.', 403);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    invariant(within(rootPath, fs.realpathSync(directory)), 'WS_PATH_ESCAPE_BLOCKED',
      'The reserved WebSpider path escaped the workspace root.', 403);

    const relativePath = '.webspider/WEBSPIDER_USER_GUIDE.txt';
    const destination = path.join(directory, 'WEBSPIDER_USER_GUIDE.txt');
    try {
      const stat = fs.lstatSync(destination);
      invariant(stat.isFile() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
        'WebSpider user guide destination is not a regular file.', 403);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.user-guide-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or already removed */ }
    }
    invariant(within(rootPath, fs.realpathSync(destination)), 'WS_PATH_ESCAPE_BLOCKED',
      'WebSpider user guide escaped the workspace root.', 403);
    return { relative_path: relativePath, size_bytes: bytes.length };
  }

  writeImageUpload(rootId, { uploadId, mimeType, bytes, sha256 }) {
    const root = this.getRoot(rootId);
    const validated = validateImageUpload({ uploadId, mimeType, bytes, sha256 });
    const rootPath = this.#currentRoot(root);
    let directory = root.anchor;
    for (const component of ['.webspider', 'uploads']) {
      directory = path.join(directory, component);
      try {
        const stat = fs.lstatSync(directory);
        invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
          'The reserved WebSpider upload path is not a real directory.', 403);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      invariant(within(rootPath, fs.realpathSync(directory)), 'WS_PATH_ESCAPE_BLOCKED',
        'The reserved WebSpider upload path escaped the workspace root.', 403);
    }

    const storedName = `${uploadId}.${validated.extension}`;
    const relativePath = `.webspider/uploads/${storedName}`;
    const destination = path.join(directory, storedName);
    try {
      const stat = fs.lstatSync(destination);
      invariant(stat.isFile() && !stat.isSymbolicLink(), 'WS_PATH_ESCAPE_BLOCKED',
        'Image upload destination is not a regular file.', 403);
      const existing = fs.readFileSync(destination);
      invariant(createHash('sha256').update(existing).digest('hex') === validated.sha256,
        'WS_CONFLICT', 'Image upload ID already exists with different content.', 409);
      return { upload_id: uploadId, relative_path: relativePath, duplicate: true, ...validated };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(directory, `.image-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or already removed */ }
    }
    invariant(within(rootPath, fs.realpathSync(destination)), 'WS_PATH_ESCAPE_BLOCKED',
      'Pasted image escaped the workspace root.', 403);
    return { upload_id: uploadId, relative_path: relativePath, duplicate: false, ...validated };
  }

  #candidate(root, parts) {
    return parts.length ? path.join(root.anchor, ...parts) : root.anchor;
  }

  #currentRoot(root) {
    try {
      const configured = fs.realpathSync(root.canonical);
      const configuredStat = fs.statSync(configured);
      if (configuredStat.dev !== root.device || configuredStat.ino !== root.inode) throw new Error('root identity changed');
      const current = fs.realpathSync(root.anchor);
      const stat = fs.statSync(current);
      if (stat.dev !== root.device || stat.ino !== root.inode) throw new Error('root identity changed');
      return current;
    } catch {
      throw new WebSpiderError('WS_ROOT_REVOKED', 'Workspace root is no longer available.', 410);
    }
  }

  #preflight(root, parts) {
    this.#currentRoot(root);
    let current = root.anchor;
    let finalStat = fs.fstatSync(root.fd);
    for (const part of parts) {
      current = path.join(current, part);
      try {
        finalStat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') throw new WebSpiderError('WS_NOT_FOUND', 'File or directory not found.', 404);
        throw error;
      }
      if (finalStat.isSymbolicLink() && root.symlinkPolicy === 'no_symlinks') {
        throw new WebSpiderError('WS_SYMLINK_BLOCKED', 'Symbolic links are blocked for this root.', 403);
      }
    }
    return finalStat;
  }

  async #open(root, relativePath, expectedKind = null) {
    const parts = validateRelativePath(relativePath, { allowEmpty: expectedKind === 'directory' });
    const preflightStat = this.#preflight(root, parts);
    if (expectedKind === 'file' && !preflightStat.isFile() && !preflightStat.isSymbolicLink()) {
      throw new WebSpiderError('WS_SPECIAL_FILE_BLOCKED', 'Only regular files may be opened.', 403);
    }
    if (expectedKind === 'directory' && !preflightStat.isDirectory() && !preflightStat.isSymbolicLink()) {
      throw new WebSpiderError('WS_PATH_INVALID', 'Expected a directory.', 400);
    }
    const candidate = this.#candidate(root, parts);
    const noFollow = root.symlinkPolicy === 'no_symlinks' && parts.length ? O_NOFOLLOW : 0;
    const directoryFlag = expectedKind === 'directory' ? O_DIRECTORY : 0;
    let handle;
    try {
      handle = await fs.promises.open(candidate, O_RDONLY | O_CLOEXEC | noFollow | directoryFlag);
    } catch (error) {
      if (['ELOOP', 'EMLINK'].includes(error.code)) {
        throw new WebSpiderError('WS_SYMLINK_BLOCKED', 'Symbolic link traversal was blocked.', 403);
      }
      if (error.code === 'ENOENT') throw new WebSpiderError('WS_NOT_FOUND', 'File or directory not found.', 404);
      if (error.code === 'ENOTDIR') throw new WebSpiderError('WS_PATH_INVALID', 'Expected a directory.', 400);
      throw error;
    }
    try {
      const rootPath = this.#currentRoot(root);
      const handlePath = root.usesProc
        ? fs.realpathSync(`/proc/self/fd/${handle.fd}`)
        : fs.realpathSync(candidate);
      if (!root.usesProc) {
        const pathStat = fs.statSync(handlePath);
        const handleStat = await handle.stat();
        invariant(pathStat.dev === handleStat.dev && pathStat.ino === handleStat.ino,
          'WS_PATH_ESCAPE_BLOCKED', 'Path changed while it was being opened.', 403);
      }
      invariant(within(rootPath, handlePath), 'WS_PATH_ESCAPE_BLOCKED', 'Path escaped the workspace root.', 403);
      const stat = await handle.stat();
      if (root.mountPolicy === 'same_filesystem_only') {
        invariant(stat.dev === root.device, 'WS_PATH_ESCAPE_BLOCKED', 'Cross-filesystem access is blocked.', 403);
      }
      if (expectedKind === 'directory') invariant(stat.isDirectory(), 'WS_PATH_INVALID', 'Expected a directory.');
      if (expectedKind === 'file') invariant(stat.isFile(), 'WS_SPECIAL_FILE_BLOCKED', 'Only regular files may be opened.', 403);
      return { handle, stat, resolvedPath: handlePath, relativePath: parts.join('/') };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async entries(rootId, relativePath = '', { includeHidden = false, sort = 'name', direction = 'asc', cursor = 0, limit = 250 } = {}) {
    const root = this.getRoot(rootId);
    const opened = await this.#open(root, relativePath, 'directory');
    try {
      const directoryPath = root.usesProc ? `/proc/self/fd/${opened.handle.fd}` : opened.resolvedPath;
      const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      const values = [];
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const itemPath = path.join(directoryPath, entry.name);
        const stat = await fs.promises.lstat(itemPath);
        let extra = {};
        if (stat.isSymbolicLink()) {
          let target;
          let contained = false;
          try {
            target = await fs.promises.readlink(itemPath);
            const resolved = await fs.promises.realpath(itemPath);
            contained = within(this.#currentRoot(root), resolved);
          } catch { /* broken or blocked link */ }
          extra = {
            link_target: target ? path.basename(target) : null,
            link_scope: contained ? 'inside_workspace' : 'blocked_external_or_broken',
            downloadable: false,
            previewable: false,
          };
        }
        values.push(metadata(entry.name, stat, extra));
      }
      if (!root.usesProc) {
        const after = await fs.promises.stat(directoryPath);
        invariant(after.dev === opened.stat.dev && after.ino === opened.stat.ino,
          'WS_PATH_ESCAPE_BLOCKED', 'Directory changed while it was being listed.', 403);
      }
      const factor = direction === 'desc' ? -1 : 1;
      values.sort((a, b) => {
        if (sort === 'size') return ((a.size || 0) - (b.size || 0)) * factor;
        if (sort === 'mtime') return a.mtime.localeCompare(b.mtime) * factor;
        if (a.kind === 'directory' && b.kind !== 'directory') return -1;
        if (b.kind === 'directory' && a.kind !== 'directory') return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * factor;
      });
      const start = Math.max(0, Number(cursor) || 0);
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 250));
      const page = values.slice(start, start + pageSize);
      return {
        root_id: rootId,
        path: relativePath,
        entries: page,
        next_cursor: start + page.length < values.length ? String(start + page.length) : null,
      };
    } finally {
      await opened.handle.close();
    }
  }

  async stat(rootId, relativePath) {
    const root = this.getRoot(rootId);
    const parts = validateRelativePath(relativePath);
    const candidate = this.#candidate(root, parts);
    this.#preflight(root, parts.slice(0, -1));
    let stat;
    try {
      stat = await fs.promises.lstat(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') throw new WebSpiderError('WS_NOT_FOUND', 'File or directory not found.', 404);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let target = null;
      let scope = 'blocked_external_or_broken';
      try {
        target = await fs.promises.readlink(candidate);
        const resolved = await fs.promises.realpath(candidate);
        if (within(this.#currentRoot(root), resolved)) scope = 'inside_workspace';
      } catch { /* preserve blocked metadata */ }
      return metadata(path.basename(relativePath), stat, {
        path: relativePath,
        link_target: target ? path.basename(target) : null,
        link_scope: scope,
        downloadable: false,
        previewable: false,
      });
    }
    const expected = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    if (expected) {
      const opened = await this.#open(root, relativePath, expected);
      await opened.handle.close();
    }
    return metadata(path.basename(relativePath) || root.displayName, stat, { path: relativePath });
  }

  async readFile(rootId, relativePath, { maxBytes = this.maxDownloadBytes } = {}) {
    const root = this.getRoot(rootId);
    invariant(root.allowDownload, 'WS_FORBIDDEN', 'Downloads are disabled for this root.', 403);
    const opened = await this.#open(root, relativePath, 'file');
    try {
      invariant(opened.stat.size <= maxBytes, 'WS_FILE_TOO_LARGE', `File exceeds the ${maxBytes}-byte transfer limit.`, 413);
      const bytes = await opened.handle.readFile();
      return {
        bytes,
        size: Number(opened.stat.size),
        mtime: opened.stat.mtime.toISOString(),
        etag: `W/"${opened.stat.size}-${Math.trunc(opened.stat.mtimeMs)}"`,
        name: path.basename(relativePath),
      };
    } finally {
      await opened.handle.close();
    }
  }

  async preview(rootId, relativePath) {
    const root = this.getRoot(rootId);
    invariant(root.allowPreview, 'WS_FORBIDDEN', 'Previews are disabled for this root.', 403);
    const extension = path.extname(relativePath).toLowerCase();
    invariant(!ACTIVE_PREVIEW_EXTENSIONS.has(extension), 'WS_PREVIEW_UNSAFE', 'Active content is download-only.', 415);
    invariant(TEXT_EXTENSIONS.has(extension), 'WS_PREVIEW_UNSUPPORTED', 'This file type is download-only.', 415);
    const file = await this.readFile(rootId, relativePath, { maxBytes: this.maxTextPreviewBytes });
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    } catch {
      throw new WebSpiderError('WS_PREVIEW_UNSUPPORTED', 'File is not valid UTF-8 text.', 415);
    }
    invariant(!text.includes('\0'), 'WS_PREVIEW_UNSUPPORTED', 'Binary content is download-only.', 415);
    return {
      root_id: rootId,
      path: relativePath,
      kind: extension === '.csv' || extension === '.tsv' ? 'table_text' : 'text',
      content: text,
      truncated: false,
      size: file.size,
      etag: file.etag,
    };
  }

  async search(rootId, query, relativePath = '', options = {}) {
    const root = this.getRoot(rootId);
    invariant(root.allowSearch, 'WS_FORBIDDEN', 'Search is disabled for this root.', 403);
    invariant(typeof query === 'string' && query.trim().length > 0 && query.length <= 512,
      'WS_VALIDATION', 'Search query must contain 1-512 characters.');
    validateRelativePath(relativePath);
    const deadline = Date.now() + Math.min(options.maxMs || this.maxSearchMs, this.maxSearchMs);
    const maxMatches = Math.min(options.maxMatches || this.maxSearchMatches, this.maxSearchMatches);
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    const results = [];
    let scanned = 0;

    const walk = async (directory) => {
      if (Date.now() > deadline) throw new WebSpiderError('WS_SEARCH_LIMIT_EXCEEDED', 'Search time limit exceeded.', 429);
      const listing = await this.entries(rootId, directory, { includeHidden: options.includeHidden, limit: 500 });
      for (const entry of listing.entries) {
        if (results.length >= maxMatches) return;
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        const candidateName = options.caseSensitive ? entry.name : entry.name.toLocaleLowerCase();
        if (candidateName.includes(needle)) results.push({ path: relative, kind: entry.kind, match: 'filename' });
        if (entry.kind === 'directory') {
          await walk(relative);
        } else if (entry.kind === 'file' && options.content !== false && entry.size <= (options.maxFileBytes || 1_048_576)) {
          const extension = path.extname(entry.name).toLowerCase();
          if (!TEXT_EXTENSIONS.has(extension)) continue;
          scanned += 1;
          try {
            const file = await this.readFile(rootId, relative, { maxBytes: options.maxFileBytes || 1_048_576 });
            const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
            const lines = text.split(/\r?\n/);
            for (let index = 0; index < lines.length && results.length < maxMatches; index += 1) {
              const haystack = options.caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
              if (haystack.includes(needle)) {
                results.push({ path: relative, kind: 'file', match: 'content', line: index + 1, excerpt: lines[index].slice(0, 500) });
              }
            }
          } catch (error) {
            if (!['WS_PREVIEW_UNSUPPORTED', 'WS_FILE_TOO_LARGE'].includes(error.code)) throw error;
          }
        }
      }
    };

    await walk(relativePath);
    return { root_id: rootId, path: relativePath, query, results, scanned_files: scanned, limited: results.length >= maxMatches };
  }

  gitStatus(rootId, relativePath = '') {
    const root = this.getRoot(rootId);
    const parts = validateRelativePath(relativePath);
    this.#preflight(root, parts);
    const rootPath = this.#currentRoot(root);
    const args = ['-C', rootPath, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'];
    if (relativePath) args.push('--', relativePath);
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000 });
    if (result.status !== 0) {
      return { root_id: rootId, repository: false, entries: [], error: result.stderr?.trim() || null };
    }
    const entries = result.stdout.split('\0').filter(Boolean).map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
    }));
    const branch = spawnSync('git', ['-C', rootPath, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5_000 }).stdout?.trim();
    return { root_id: rootId, repository: true, branch: branch || '(detached)', entries };
  }
}
