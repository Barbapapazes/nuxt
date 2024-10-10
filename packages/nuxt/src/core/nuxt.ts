import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, normalize, relative, resolve } from 'pathe'
import { createDebugger, createHooks } from 'hookable'
import ignore from 'ignore'
import type { LoadNuxtOptions } from '@nuxt/kit'
import { addBuildPlugin, addComponent, addPlugin, addPluginTemplate, addRouteMiddleware, addServerPlugin, addVitePlugin, addWebpackPlugin, installModule, loadNuxtConfig, logger, nuxtCtx, resolveAlias, resolveFiles, resolveIgnorePatterns, resolvePath, tryResolveModule, useNitro } from '@nuxt/kit'
import { resolvePath as _resolvePath } from 'mlly'
import type { Nuxt, NuxtHooks, NuxtModule, NuxtOptions } from 'nuxt/schema'
import type { PackageJson } from 'pkg-types'
import { readPackageJSON } from 'pkg-types'
import { hash } from 'ohash'
import consola from 'consola'
import { colorize } from 'consola/utils'
import { updateConfig } from 'c12/update'
import { formatDate, resolveCompatibilityDatesFromEnv } from 'compatx'
import type { DateString } from 'compatx'
import escapeRE from 'escape-string-regexp'
import { withTrailingSlash, withoutLeadingSlash } from 'ufo'
import { ImpoundPlugin } from 'impound'
import type { ImpoundOptions } from 'impound'
import defu from 'defu'
import { gt, satisfies } from 'semver'
import { hasTTY, isCI } from 'std-env'

import pagesModule from '../pages/module'
import metaModule from '../head/module'
import componentsModule from '../components/module'
import importsModule from '../imports/module'

import { distDir, pkgDir } from '../dirs'
import { version } from '../../package.json'
import { scriptsStubsPreset } from '../imports/presets'
import { resolveTypePath } from './utils/types'
import { createImportProtectionPatterns } from './plugins/import-protection'
import { UnctxTransformPlugin } from './plugins/unctx'
import { TreeShakeComposablesPlugin } from './plugins/tree-shake'
import { DevOnlyPlugin } from './plugins/dev-only'
import { LayerAliasingPlugin } from './plugins/layer-aliasing'
import { addModuleTranspiles } from './modules'
import { initNitro } from './nitro'
import schemaModule from './schema'
import { RemovePluginMetadataPlugin } from './plugins/plugin-metadata'
import { AsyncContextInjectionPlugin } from './plugins/async-context'
import { resolveDeepImportsPlugin } from './plugins/resolve-deep-imports'
import { prehydrateTransformPlugin } from './plugins/prehydrate'
import { VirtualFSPlugin } from './plugins/virtual'

export function createNuxt (options: NuxtOptions): Nuxt {
  const hooks = createHooks<NuxtHooks>()

  const nuxt: Nuxt = {
    _version: version,
    options,
    hooks,
    callHook: hooks.callHook,
    addHooks: hooks.addHooks,
    hook: hooks.hook,
    ready: () => initNuxt(nuxt),
    close: () => hooks.callHook('close', nuxt),
    vfs: {},
    apps: {},
  }

  hooks.hookOnce('close', () => { hooks.removeAllHooks() })

  return nuxt
}

// TODO: update to nitro import
const fallbackCompatibilityDate = '2024-04-03' as DateString

const nightlies = {
  'nitropack': 'nitropack-nightly',
  'nitro': 'nitro-nightly',
  'h3': 'h3-nightly',
  'nuxt': 'nuxt-nightly',
  '@nuxt/schema': '@nuxt/schema-nightly',
  '@nuxt/kit': '@nuxt/kit-nightly',
}

const keyDependencies = [
  '@nuxt/kit',
  '@nuxt/schema',
]

let warnedAboutCompatDate = false

async function initNuxt (nuxt: Nuxt) {
  // Register user hooks
  for (const config of nuxt.options._layers.map(layer => layer.config).reverse()) {
    if (config.hooks) {
      nuxt.hooks.addHooks(config.hooks)
    }
  }

  // Prompt to set compatibility date
  nuxt.options.compatibilityDate = resolveCompatibilityDatesFromEnv(nuxt.options.compatibilityDate)

  if (!nuxt.options.compatibilityDate.default) {
    const todaysDate = formatDate(new Date())
    nuxt.options.compatibilityDate.default = fallbackCompatibilityDate

    const shouldShowPrompt = nuxt.options.dev && hasTTY && !isCI
    if (!shouldShowPrompt) {
      logger.info(`Using \`${fallbackCompatibilityDate}\` as fallback compatibility date.`)
    }

    async function promptAndUpdate () {
      const result = await consola.prompt(`Do you want to update your ${colorize('cyan', 'nuxt.config')} to set ${colorize('cyan', `compatibilityDate: '${todaysDate}'`)}?`, {
        type: 'confirm',
        default: true,
      })
      if (result !== true) {
        logger.info(`Using \`${fallbackCompatibilityDate}\` as fallback compatibility date.`)
        return
      }

      try {
        const res = await updateConfig({
          configFile: 'nuxt.config',
          cwd: nuxt.options.rootDir,
          async onCreate ({ configFile }) {
            const shallCreate = await consola.prompt(`Do you want to create ${colorize('cyan', relative(nuxt.options.rootDir, configFile))}?`, {
              type: 'confirm',
              default: true,
            })
            if (shallCreate !== true) {
              return false
            }
            return _getDefaultNuxtConfig()
          },
          onUpdate (config) {
            config.compatibilityDate = todaysDate
          },
        })

        if (res?.configFile) {
          nuxt.options.compatibilityDate = resolveCompatibilityDatesFromEnv(todaysDate)
          consola.success(`Compatibility date set to \`${todaysDate}\` in \`${relative(nuxt.options.rootDir, res.configFile)}\``)
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : err

        consola.error(`Failed to update config: ${message}`)
      }

      logger.info(`Using \`${fallbackCompatibilityDate}\` as fallback compatibility date.`)
    }

    nuxt.hooks.hookOnce('nitro:init', (nitro) => {
      if (warnedAboutCompatDate) { return }

      nitro.hooks.hookOnce('compiled', () => {
        warnedAboutCompatDate = true
        // Print warning
        logger.info(`Nuxt now supports pinning the behavior of provider and deployment presets with a compatibility date. We recommend you specify a \`compatibilityDate\` in your \`nuxt.config\` file, or set an environment variable, such as \`COMPATIBILITY_DATE=${todaysDate}\`.`)
        if (shouldShowPrompt) { promptAndUpdate() }
      })
    })
  }

  // Restart Nuxt when layer directories are added or removed
  const layersDir = withTrailingSlash(resolve(nuxt.options.rootDir, 'layers'))
  nuxt.hook('builder:watch', (event, relativePath) => {
    const path = resolve(nuxt.options.srcDir, relativePath)
    if (event === 'addDir' || event === 'unlinkDir') {
      if (path.startsWith(layersDir)) {
        return nuxt.callHook('restart', { hard: true })
      }
    }
  })

  // Set nuxt instance for useNuxt
  nuxtCtx.set(nuxt)
  nuxt.hook('close', () => nuxtCtx.unset())

  const coreTypePackages = nuxt.options.typescript.hoist || []
  const packageJSON = await readPackageJSON(nuxt.options.rootDir).catch(() => ({}) as PackageJson)
  nuxt._dependencies = new Set([...Object.keys(packageJSON.dependencies || {}), ...Object.keys(packageJSON.devDependencies || {})])
  const paths = Object.fromEntries(await Promise.all(coreTypePackages.map(async (pkg) => {
    const [_pkg = pkg, _subpath] = /^[^@]+\//.test(pkg) ? pkg.split('/') : [pkg]
    const subpath = _subpath ? '/' + _subpath : ''

    // ignore packages that exist in `package.json` as these can be resolved by TypeScript
    if (nuxt._dependencies?.has(_pkg) && !(_pkg in nightlies)) { return [] }

    // deduplicate types for nightly releases
    if (_pkg in nightlies) {
      const nightly = nightlies[_pkg as keyof typeof nightlies]
      const path = await resolveTypePath(nightly + subpath, subpath, nuxt.options.modulesDir)
      if (path) {
        return [[pkg, [path]], [nightly + subpath, [path]]]
      }
    }

    const path = await resolveTypePath(_pkg + subpath, subpath, nuxt.options.modulesDir)
    if (path) {
      return [[pkg, [path]]]
    }

    return []
  })).then(r => r.flat()))

  // Set nitro resolutions for types that might be obscured with shamefully-hoist=false
  nuxt.options.nitro.typescript = defu(nuxt.options.nitro.typescript, {
    tsConfig: { compilerOptions: { paths: { ...paths } } },
  })

  // Add nuxt types
  nuxt.hook('prepare:types', (opts) => {
    opts.references.push({ types: 'nuxt' })
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/plugins.d.ts') })
    // Add vue shim
    if (nuxt.options.typescript.shim) {
      opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/vue-shim.d.ts') })
    }
    // Add shims for `#build/*` imports that do not already have matching types
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/build.d.ts') })
    // Add module augmentations directly to NuxtConfig
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/schema.d.ts') })
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/app.config.d.ts') })

    // Set Nuxt resolutions for types that might be obscured with shamefully-hoist=false
    opts.tsConfig.compilerOptions = defu(opts.tsConfig.compilerOptions, { paths: { ...paths } })

    for (const layer of nuxt.options._layers) {
      const declaration = join(layer.cwd, 'index.d.ts')
      if (existsSync(declaration)) {
        opts.references.push({ path: declaration })
      }
    }
  })

  // Prompt to install `@nuxt/scripts` if user has configured it
  // @ts-expect-error scripts types are not present as the module is not installed
  if (nuxt.options.scripts) {
    if (!nuxt.options._modules.some(m => m === '@nuxt/scripts' || m === '@nuxt/scripts-nightly')) {
      await import('../core/features').then(({ installNuxtModule }) => installNuxtModule('@nuxt/scripts'))
    }
  }

  // Support Nuxt VFS
  addBuildPlugin(VirtualFSPlugin(nuxt, { mode: 'server' }), { client: false })
  addBuildPlugin(VirtualFSPlugin(nuxt, { mode: 'client', alias: { 'nitro/runtime': join(nuxt.options.buildDir, 'nitro.client.mjs') } }), { server: false })

  // Add plugin normalization plugin
  addBuildPlugin(RemovePluginMetadataPlugin(nuxt))

  // Add import protection
  const config: ImpoundOptions = {
    cwd: nuxt.options.rootDir,
    // Exclude top-level resolutions by plugins
    exclude: [join(nuxt.options.srcDir, 'index.html')],
    patterns: createImportProtectionPatterns(nuxt, { context: 'nuxt-app' }),
  }
  addVitePlugin(() => Object.assign(ImpoundPlugin.vite({ ...config, error: false }), { name: 'nuxt:import-protection' }), { client: false })
  addVitePlugin(() => Object.assign(ImpoundPlugin.vite({ ...config, error: true }), { name: 'nuxt:import-protection' }), { server: false })
  addWebpackPlugin(() => ImpoundPlugin.webpack(config))

  // add resolver for modules used in virtual files
  addVitePlugin(() => resolveDeepImportsPlugin(nuxt), { client: false })
  addVitePlugin(() => resolveDeepImportsPlugin(nuxt), { server: false })

  // Add transform for `onPrehydrate` lifecycle hook
  addBuildPlugin(prehydrateTransformPlugin(nuxt))

  if (nuxt.options.experimental.localLayerAliases) {
    // Add layer aliasing support for ~, ~~, @ and @@ aliases
    addBuildPlugin(LayerAliasingPlugin({
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
      dev: nuxt.options.dev,
      root: nuxt.options.srcDir,
      // skip top-level layer (user's project) as the aliases will already be correctly resolved
      layers: nuxt.options._layers.slice(1),
    }))
  }

  nuxt.hook('modules:done', async () => {
    // Add unctx transform
    addBuildPlugin(UnctxTransformPlugin({
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
      transformerOptions: {
        ...nuxt.options.optimization.asyncTransforms,
        helperModule: await tryResolveModule('unctx', nuxt.options.modulesDir) ?? 'unctx',
      },
    }))

    // Add composable tree-shaking optimisations
    if (Object.keys(nuxt.options.optimization.treeShake.composables.server).length) {
      addBuildPlugin(TreeShakeComposablesPlugin({
        sourcemap: !!nuxt.options.sourcemap.server,
        composables: nuxt.options.optimization.treeShake.composables.server,
      }), { client: false })
    }
    if (Object.keys(nuxt.options.optimization.treeShake.composables.client).length) {
      addBuildPlugin(TreeShakeComposablesPlugin({
        sourcemap: !!nuxt.options.sourcemap.client,
        composables: nuxt.options.optimization.treeShake.composables.client,
      }), { server: false })
    }
  })

  if (!nuxt.options.dev) {
    // DevOnly component tree-shaking - build time only
    addBuildPlugin(DevOnlyPlugin({
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
    }))
  }

  if (nuxt.options.dev) {
    // Add plugin to check if layouts are defined without NuxtLayout being instantiated
    addPlugin(resolve(nuxt.options.appDir, 'plugins/check-if-layout-used'))
  }

  if (nuxt.options.dev && nuxt.options.features.devLogs) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/dev-server-logs'))
    addServerPlugin(resolve(distDir, 'core/runtime/nitro/dev-server-logs'))
    nuxt.options.nitro = defu(nuxt.options.nitro, {
      externals: {
        inline: [/#internal\/dev-server-logs-options/],
      },
      virtual: {
        '#internal/dev-server-logs-options': () => `export const rootDir = ${JSON.stringify(nuxt.options.rootDir)};`,
      },
    })
  }

  // Transform initial composable call within `<script setup>` to preserve context
  if (nuxt.options.experimental.asyncContext) {
    addBuildPlugin(AsyncContextInjectionPlugin(nuxt))
  }

  // TODO: [Experimental] Avoid emitting assets when flag is enabled
  if (nuxt.options.features.noScripts && !nuxt.options.dev) {
    nuxt.hook('build:manifest', async (manifest) => {
      for (const chunk of Object.values(manifest)) {
        if (chunk.resourceType === 'script') {
          await rm(resolve(nuxt.options.buildDir, 'dist/client', withoutLeadingSlash(nuxt.options.app.buildAssetsDir), chunk.file), { force: true })
          chunk.file = ''
        }
      }
    })
  }

  // Transpile #app if it is imported directly from subpath export
  nuxt.options.build.transpile.push('nuxt/app')

  // Transpile layers within node_modules
  nuxt.options.build.transpile.push(
    ...nuxt.options._layers.filter(i => i.cwd.includes('node_modules')).map(i => i.cwd as string),
  )

  // Ensure we can resolve dependencies within layers
  nuxt.options.modulesDir.push(...nuxt.options._layers.map(l => resolve(l.cwd, 'node_modules')))

  // Init user modules
  await nuxt.callHook('modules:before')
  const modulesToInstall = new Map<string | NuxtModule, Record<string, any>>()

  const watchedPaths = new Set<string>()
  const specifiedModules = new Set<string>()

  for (const _mod of nuxt.options.modules) {
    const mod = Array.isArray(_mod) ? _mod[0] : _mod
    if (typeof mod !== 'string') { continue }
    const modPath = await resolvePath(resolveAlias(mod), { fallbackToOriginal: true })
    specifiedModules.add(modPath)
  }

  // Automatically register user modules
  for (const config of nuxt.options._layers.map(layer => layer.config).reverse()) {
    const modulesDir = (config.rootDir === nuxt.options.rootDir ? nuxt.options : config).dir?.modules || 'modules'
    const layerModules = await resolveFiles(config.srcDir, [
      `${modulesDir}/*{${nuxt.options.extensions.join(',')}}`,
      `${modulesDir}/*/index{${nuxt.options.extensions.join(',')}}`,
    ])
    for (const mod of layerModules) {
      watchedPaths.add(mod)
      if (specifiedModules.has(mod)) { continue }
      specifiedModules.add(mod)
      modulesToInstall.set(mod, {})
    }
  }

  // Register user and then ad-hoc modules
  for (const key of ['modules', '_modules'] as const) {
    for (const item of nuxt.options[key as 'modules']) {
      if (item) {
        const [key, options = {}] = Array.isArray(item) ? item : [item]
        if (!modulesToInstall.has(key)) {
          modulesToInstall.set(key, options)
        }
      }
    }
  }

  // Add <NuxtWelcome>
  addComponent({
    name: 'NuxtWelcome',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/welcome'),
  })

  addComponent({
    name: 'NuxtLayout',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-layout'),
  })

  // Add <NuxtErrorBoundary>
  addComponent({
    name: 'NuxtErrorBoundary',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-error-boundary'),
  })

  // Add <ClientOnly>
  addComponent({
    name: 'ClientOnly',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/client-only'),
  })

  // Add <DevOnly>
  addComponent({
    name: 'DevOnly',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/dev-only'),
  })

  // Add <ServerPlaceholder>
  addComponent({
    name: 'ServerPlaceholder',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/server-placeholder'),
  })

  // Add <NuxtLink>
  addComponent({
    name: 'NuxtLink',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-link'),
  })

  // Add <NuxtLoadingIndicator>
  addComponent({
    name: 'NuxtLoadingIndicator',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-loading-indicator'),
  })

  // Add <NuxtRouteAnnouncer>
  addComponent({
    name: 'NuxtRouteAnnouncer',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-route-announcer'),
    mode: 'client',
  })

  // Add <NuxtClientFallback>
  if (nuxt.options.experimental.clientFallback) {
    addComponent({
      name: 'NuxtClientFallback',
      _raw: true,
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/client-fallback.client'),
      mode: 'client',
    })

    addComponent({
      name: 'NuxtClientFallback',
      _raw: true,
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/client-fallback.server'),
      mode: 'server',
    })
  }

  // Add stubs for <NuxtImg> and <NuxtPicture>
  for (const name of ['NuxtImg', 'NuxtPicture']) {
    addComponent({
      name,
      export: name,
      priority: -1,
      filePath: resolve(nuxt.options.appDir, 'components/nuxt-stubs'),
      // @ts-expect-error TODO: refactor to nuxi
      _internal_install: '@nuxt/image',
    })
  }

  // Track components used to render for webpack
  if (nuxt.options.builder === '@nuxt/webpack-builder') {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/preload.server'))
  }

  const envMap = {
    // defaults from `builder` based on package name
    '@nuxt/rspack-builder': '@rspack/core/module',
    '@nuxt/vite-builder': 'vite/client',
    '@nuxt/webpack-builder': 'webpack/module',
    // simpler overrides from `typescript.builder` for better DX
    'rspack': '@rspack/core/module',
    'vite': 'vite/client',
    'webpack': 'webpack/module',
    // default 'merged' builder environment for module authors
    'shared': '@nuxt/schema/builder-env',
  }

  nuxt.hook('prepare:types', ({ references }) => {
    // Disable entirely if `typescript.builder` is false
    if (nuxt.options.typescript.builder === false) { return }

    const overrideEnv = nuxt.options.typescript.builder && envMap[nuxt.options.typescript.builder]
    // If there's no override, infer based on builder. If a custom builder is provided, we disable shared types
    const defaultEnv = typeof nuxt.options.builder === 'string' ? envMap[nuxt.options.builder] : false
    const types = overrideEnv || defaultEnv

    if (types) { references.push({ types }) }
  })

  // Add nuxt app debugger
  if (nuxt.options.debug) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/debug'))
  }

  for (const [key, options] of modulesToInstall) {
    await installModule(key, options)
  }

  // (Re)initialise ignore handler with resolved ignores from modules
  nuxt._ignore = ignore(nuxt.options.ignoreOptions)
  nuxt._ignore.add(resolveIgnorePatterns())

  await nuxt.callHook('modules:done')

  // Add <NuxtIsland>
  if (nuxt.options.experimental.componentIslands) {
    addComponent({
      name: 'NuxtIsland',
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/nuxt-island'),
    })

    if (!nuxt.options.ssr && nuxt.options.experimental.componentIslands !== 'auto') {
      nuxt.options.ssr = true
      nuxt.options.nitro.routeRules ||= {}
      nuxt.options.nitro.routeRules['/**'] = defu(nuxt.options.nitro.routeRules['/**'], { ssr: false })
    }
  }

  // Add prerender payload support
  if (!nuxt.options.dev && nuxt.options.experimental.payloadExtraction) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/payload.client'))
  }

  // Add experimental cross-origin prefetch support using Speculation Rules API
  if (nuxt.options.experimental.crossOriginPrefetch) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/cross-origin-prefetch.client'))
  }

  // Add experimental page reload support
  if (nuxt.options.experimental.emitRouteChunkError === 'automatic') {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/chunk-reload.client'))
  }
  // Add experimental session restoration support
  if (nuxt.options.experimental.restoreState) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/restore-state.client'))
  }

  // Add experimental automatic view transition api support
  if (nuxt.options.experimental.viewTransition) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/view-transitions.client'))
  }

  // Add experimental support for custom types in JSON payload
  if (nuxt.options.experimental.renderJsonPayloads) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/revive-payload.client'))
    addPlugin(resolve(nuxt.options.appDir, 'plugins/revive-payload.server'))
  }

  if (nuxt.options.experimental.appManifest) {
    addRouteMiddleware({
      name: 'manifest-route-rule',
      path: resolve(nuxt.options.appDir, 'middleware/manifest-route-rule'),
      global: true,
    })

    if (nuxt.options.experimental.checkOutdatedBuildInterval !== false) {
      addPlugin(resolve(nuxt.options.appDir, 'plugins/check-outdated-build.client'))
    }
  }

  if (nuxt.options.experimental.navigationRepaint) {
    addPlugin({
      src: resolve(nuxt.options.appDir, 'plugins/navigation-repaint.client'),
    })
  }

  if (nuxt.options.vue.config && Object.values(nuxt.options.vue.config).some(v => v !== null && v !== undefined)) {
    addPluginTemplate({
      filename: 'vue-app-config.mjs',
      getContents: () => `
import { defineNuxtPlugin } from '#app/nuxt'
export default defineNuxtPlugin({
  name: 'nuxt:vue-app-config',
  enforce: 'pre',
  setup (nuxtApp) {
    ${Object.keys(nuxt.options.vue.config!).map(k => `    nuxtApp.vueApp.config[${JSON.stringify(k)}] = ${JSON.stringify(nuxt.options.vue.config![k as 'idPrefix'])}`).join('\n')}
  }
})`,
    })
  }

  nuxt.hooks.hook('builder:watch', (event, relativePath) => {
    const path = resolve(nuxt.options.srcDir, relativePath)
    // Local module patterns
    if (watchedPaths.has(path)) {
      return nuxt.callHook('restart', { hard: true })
    }

    // User provided patterns
    const layerRelativePaths = nuxt.options._layers.map(l => relative(l.config.srcDir || l.cwd, path))
    for (const pattern of nuxt.options.watch) {
      if (typeof pattern === 'string') {
        // Test (normalized) strings against absolute path and relative path to any layer `srcDir`
        if (pattern === path || layerRelativePaths.includes(pattern)) { return nuxt.callHook('restart') }
        continue
      }
      // Test regular expressions against path to _any_ layer `srcDir`
      if (layerRelativePaths.some(p => pattern.test(p))) {
        return nuxt.callHook('restart')
      }
    }

    // Restart Nuxt when new `app/` dir is added
    if (event === 'addDir' && path === resolve(nuxt.options.srcDir, 'app')) {
      logger.info(`\`${path}/\` ${event === 'addDir' ? 'created' : 'removed'}`)
      return nuxt.callHook('restart', { hard: true })
    }

    // Core Nuxt files: app.vue, error.vue and app.config.ts
    const isFileChange = ['add', 'unlink'].includes(event)
    if (isFileChange && RESTART_RE.test(path)) {
      logger.info(`\`${path}\` ${event === 'add' ? 'created' : 'removed'}`)
      return nuxt.callHook('restart')
    }
  })

  // Normalize windows transpile paths added by modules
  nuxt.options.build.transpile = nuxt.options.build.transpile.map(t => typeof t === 'string' ? normalize(t) : t)

  addModuleTranspiles()

  // Init nitro
  await initNitro(nuxt)

  // TODO: remove when app manifest support is landed in https://github.com/nuxt/nuxt/pull/21641
  // Add prerender payload support
  const nitro = useNitro()
  if (nitro.options.static && nuxt.options.experimental.payloadExtraction === undefined) {
    logger.warn('Using experimental payload extraction for full-static output. You can opt-out by setting `experimental.payloadExtraction` to `false`.')
    nuxt.options.experimental.payloadExtraction = true
  }
  nitro.options.replace['process.env.NUXT_PAYLOAD_EXTRACTION'] = String(!!nuxt.options.experimental.payloadExtraction)
  nitro.options._config.replace!['process.env.NUXT_PAYLOAD_EXTRACTION'] = String(!!nuxt.options.experimental.payloadExtraction)

  if (!nuxt.options.dev && nuxt.options.experimental.payloadExtraction) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/payload.client'))
  }

  // Show compatibility version banner when Nuxt is running with a compatibility version
  // that is different from the current major version
  if (!(satisfies(nuxt._version, nuxt.options.future.compatibilityVersion + '.x'))) {
    logger.info(`Running with compatibility version \`${nuxt.options.future.compatibilityVersion}\``)
  }

  await nuxt.callHook('ready', nuxt)
}

export async function loadNuxt (opts: LoadNuxtOptions): Promise<Nuxt> {
  const options = await loadNuxtConfig(opts)

  // Temporary until finding better placement for each
  options.appDir = options.alias['#app'] = resolve(distDir, 'app')
  options._majorVersion = 4

  // De-duplicate key arrays
  for (const key in options.app.head || {}) {
    options.app.head[key as 'link'] = deduplicateArray(options.app.head[key as 'link'])
  }

  // Nuxt DevTools only works for Vite
  if (options.builder === '@nuxt/vite-builder') {
    const isDevToolsEnabled = typeof options.devtools === 'boolean'
      ? options.devtools
      : options.devtools?.enabled !== false // enabled by default unless explicitly disabled

    if (isDevToolsEnabled) {
      if (!options._modules.some(m => m === '@nuxt/devtools' || m === '@nuxt/devtools-edge')) {
        options._modules.push('@nuxt/devtools')
      }
    }
  }

  if (!options._modules.some(m => m === '@nuxt/scripts' || m === '@nuxt/scripts-nightly')) {
    options.imports = defu(options.imports, {
      presets: [scriptsStubsPreset],
    })
  }

  // Nuxt Webpack Builder is currently opt-in
  if (options.builder === '@nuxt/webpack-builder') {
    if (!await import('./features').then(r => r.ensurePackageInstalled('@nuxt/webpack-builder', {
      rootDir: options.rootDir,
      searchPaths: options.modulesDir,
    }))) {
      logger.warn('Failed to install `@nuxt/webpack-builder`, please install it manually, or change the `builder` option to vite in `nuxt.config`')
    }
  }

  // Add core modules
  options._modules.push(pagesModule, metaModule, componentsModule)
  options._modules.push([importsModule, {
    transform: {
      include: options._layers
        .filter(i => i.cwd && i.cwd.includes('node_modules'))
        .map(i => new RegExp(`(^|\\/)${escapeRE(i.cwd!.split('node_modules/').pop()!)}(\\/|$)(?!node_modules\\/)`)),
    },
  }])
  options._modules.push(schemaModule)
  options.modulesDir.push(resolve(options.workspaceDir, 'node_modules'))
  options.modulesDir.push(resolve(pkgDir, 'node_modules'))
  options.build.transpile.push(
    'std-env', // we need to statically replace process.env when used in runtime code
  )
  options.alias['vue-demi'] = resolve(options.appDir, 'compat/vue-demi')
  options.alias['@vue/composition-api'] = resolve(options.appDir, 'compat/capi')
  if (options.telemetry !== false && !process.env.NUXT_TELEMETRY_DISABLED) {
    options._modules.push('@nuxt/telemetry')
  }

  // Ensure we share key config between Nuxt and Nitro
  createPortalProperties(options.nitro.runtimeConfig, options, ['nitro.runtimeConfig', 'runtimeConfig'])
  createPortalProperties(options.nitro.routeRules, options, ['nitro.routeRules', 'routeRules'])

  // prevent replacement of options.nitro
  const nitroOptions = options.nitro
  Object.defineProperties(options, {
    nitro: {
      configurable: false,
      enumerable: true,
      get: () => nitroOptions,
      set (value) {
        Object.assign(nitroOptions, value)
      },
    },
  })

  const nuxt = createNuxt(options)

  for (const dep of keyDependencies) {
    checkDependencyVersion(dep, nuxt._version)
  }

  // We register hooks layer-by-layer so any overrides need to be registered separately
  if (opts.overrides?.hooks) {
    nuxt.hooks.addHooks(opts.overrides.hooks)
  }

  if (nuxt.options.debug) {
    createDebugger(nuxt.hooks, { tag: 'nuxt' })
  }

  if (opts.ready !== false) {
    await nuxt.ready()
  }

  return nuxt
}

async function checkDependencyVersion (name: string, nuxtVersion: string): Promise<void> {
  const path = await resolvePath(name, { fallbackToOriginal: true }).catch(() => null)

  if (!path || path === name) { return }
  const { version } = await readPackageJSON(path)

  if (version && gt(nuxtVersion, version)) {
    console.warn(`[nuxt] Expected \`${name}\` to be at least \`${nuxtVersion}\` but got \`${version}\`. This might lead to unexpected behavior. Check your package.json or refresh your lockfile.`)
  }
}

const RESTART_RE = /^(?:app|error|app\.config)\.(?:js|ts|mjs|jsx|tsx|vue)$/i

function deduplicateArray<T = unknown> (maybeArray: T): T {
  if (!Array.isArray(maybeArray)) { return maybeArray }

  const fresh: any[] = []
  const hashes = new Set<string>()
  for (const item of maybeArray) {
    const _hash = hash(item)
    if (!hashes.has(_hash)) {
      hashes.add(_hash)
      fresh.push(item)
    }
  }
  return fresh as T
}

function createPortalProperties (sourceValue: any, options: NuxtOptions, paths: string[]) {
  let sharedValue = sourceValue

  for (const path of paths) {
    const segments = path.split('.')
    const key = segments.pop()!
    let parent: Record<string, any> = options

    while (segments.length) {
      const key = segments.shift()!
      parent = parent[key] || (parent[key] = {})
    }

    delete parent[key]

    Object.defineProperties(parent, {
      [key]: {
        configurable: false,
        enumerable: true,
        get: () => sharedValue,
        set (value) {
          sharedValue = value
        },
      },
    })
  }
}

const _getDefaultNuxtConfig = () => /* js */
  `// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true }
})
`
