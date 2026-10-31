/** Programmatic API of create-hypdriv (the `create-hypdriv` bin is `dist/index.js`). */
export { type CliIO, main } from './cli';
export {
  compatibilityDate,
  detectPackageManager,
  fillSecrets,
  isUsableDirectory,
  type PackageManager,
  type ScaffoldOptions,
  type ScaffoldResult,
  scaffold,
  toPackageName,
  validateName,
  workerName,
} from './scaffold';
export {
  FRAMEWORKS,
  type Framework,
  type Platform,
  parseCatalog,
  syncTemplates,
  TEMPLATE_SOURCES,
  type TemplateId,
  templateFor,
  transformHypdrivConfig,
  transformPackageJson,
  transformReadme,
  transformTsconfig,
  VITE_HOSTS,
  type ViteHost,
} from './templates';
