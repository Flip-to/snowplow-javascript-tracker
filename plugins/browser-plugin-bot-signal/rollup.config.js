import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import ts from 'rollup-plugin-ts'; // Preferred over @rollup/plugin-typescript as it bundles .d.ts files
import { banner } from '../../banner';
import { terser } from 'rollup-plugin-terser';
import cleanup from 'rollup-plugin-cleanup';
import pkg from './package.json';
import { builtinModules } from 'module';
import typescript from 'typescript';
import * as acorn from 'acorn';

// bot-signal ships ES2020 (default parameters, async functions), and the tracker bundle must stay ES5 like its siblings:
// one unparsable token in an old browser would break the whole script. `ts()` does not downlevel it (a build without this
// plugin measured as ES2020 under acorn's ES5 parse), so bot-signal's own modules are downleveled here with the repo's
// TypeScript. Helpers come from tslib, bundled once inside the UMD wrapper (no page globals), and the source map is chained.
// The target is ES5 on purpose and is not read from .browserslistrc: a chunk that fails to parse breaks the whole script.
const es5 = () => ({
  name: 'es5',
  transform(code, id) {
    const isBotSignal = /node_modules[\\/](\.pnpm[\\/][^\\/]*[\\/]node_modules[\\/])?bot-signal[\\/]/.test(id);
    if (!isBotSignal || !/\.[cm]?js$/.test(id)) {
      return null;
    }
    const out = typescript.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        target: typescript.ScriptTarget.ES5,
        module: typescript.ModuleKind.ESNext,
        allowJs: true,
        importHelpers: true,
        downlevelIteration: true,
        sourceMap: true,
        inlineSources: false,
      },
    });
    return { code: out.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, ''), map: out.sourceMapText };
  },
});

// The requirement is "the shipped UMD parses as ES5", so the build fails when it does not.
const assertEs5 = () => ({
  name: 'assert-es5',
  renderChunk(code) {
    acorn.parse(code, { ecmaVersion: 5 });
    return null;
  },
});

const umdPlugins = [es5(), nodeResolve({ browser: true }), commonjs(), ts()];
const umdName = 'snowplowBotSignal';

export default [
  // CommonJS (for Node) and ES module (for bundlers) build.
  {
    input: './src/index.ts',
    plugins: [...umdPlugins, assertEs5(), banner()],
    treeshake: { moduleSideEffects: ['sha1'] },
    output: [{ file: pkg.main, format: 'umd', sourcemap: true, name: umdName }],
  },
  {
    input: './src/index.ts',
    plugins: [...umdPlugins, assertEs5(), terser(), cleanup({ comments: 'none' }), banner()],
    treeshake: { moduleSideEffects: ['sha1'] },
    output: [{ file: pkg.main.replace('.js', '.min.js'), format: 'umd', sourcemap: true, name: umdName }],
  },
  {
    input: './src/index.ts',
    external: (id) =>
      [...builtinModules, ...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)].some(
        (d) => id === d || id.indexOf(d + '/') === 0
      ),
    plugins: [
      ts(), // so Rollup can convert TypeScript to JavaScript
      banner(),
    ],
    output: [{ file: pkg.module, format: 'es', sourcemap: true }],
  },
];
