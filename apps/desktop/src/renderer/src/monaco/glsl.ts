import type * as Monaco from 'monaco-editor';

/**
 * A self-contained GLSL (OpenGL ES / WebGL Shading Language) definition for Monaco.
 *
 * Monaco ships JS/TS/JSON/etc. but has no GLSL support, so we register a Monarch
 * tokenizer + a minimal language configuration. The keyword/type/builtin lists are
 * derived from the GLSL ES 3.0 spec (the dialect three.js shaders target). This keeps
 * Triangle dependency-free for shader highlighting; see ADR 0004.
 */

export const GLSL_LANGUAGE_ID = 'glsl';

const keywords = [
  'attribute', 'const', 'uniform', 'varying', 'buffer', 'shared', 'coherent',
  'volatile', 'restrict', 'readonly', 'writeonly', 'layout', 'centroid', 'flat',
  'smooth', 'noperspective', 'patch', 'sample', 'break', 'continue', 'do', 'for',
  'while', 'switch', 'case', 'default', 'if', 'else', 'in', 'out', 'inout', 'true',
  'false', 'invariant', 'precise', 'discard', 'return', 'struct', 'precision',
  'highp', 'mediump', 'lowp',
];

const types = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'dvec2', 'dvec3', 'dvec4',
  'bvec2', 'bvec3', 'bvec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray',
  'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow',
  'isampler2D', 'isampler3D', 'isamplerCube',
  'usampler2D', 'usampler3D', 'usamplerCube',
];

const builtins = [
  // Built-in variables.
  'gl_Position', 'gl_PointSize', 'gl_FragCoord', 'gl_FragColor', 'gl_FragData',
  'gl_FrontFacing', 'gl_PointCoord', 'gl_VertexID', 'gl_InstanceID',
  // Common built-in functions.
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh',
  'cosh', 'tanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix',
  'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize',
  'reflect', 'refract', 'faceforward', 'matrixCompMult', 'transpose', 'inverse',
  'determinant', 'texture', 'texture2D', 'textureCube', 'textureLod', 'texelFetch',
  'dFdx', 'dFdy', 'fwidth',
  // three.js-injected uniforms/attributes most shaders use.
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix',
  'normalMatrix', 'cameraPosition', 'position', 'normal', 'uv', 'tangent',
];

export const glslLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.glsl',
  keywords,
  types,
  builtins,
  operators: [
    '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++',
    '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '+=', '-=', '*=',
    '/=', '&=', '|=', '^=', '%=', '<<=', '>>=',
  ],
  symbols: /[=><!~?:&|+\-*/^%]+/,
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4})/,
  tokenizer: {
    root: [
      [/#[a-zA-Z_]\w*/, 'keyword.directive'],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@types': 'type',
            '@builtins': 'predefined',
            '@default': 'identifier',
          },
        },
      ],
      { include: '@whitespace' },
      [/[{}()[\]]/, '@brackets'],
      [/\d*\.\d+([eE][-+]?\d+)?[fF]?/, 'number.float'],
      [/0[xX][0-9a-fA-F]+[uU]?/, 'number.hex'],
      [/\d+[uU]?/, 'number'],
      [
        /@symbols/,
        { cases: { '@operators': 'operator', '@default': '' } },
      ],
      [/[;,.]/, 'delimiter'],
    ],
    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
};

export const glslLanguageConfig: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
};

/** Register the GLSL language with a Monaco instance (idempotent). */
export function registerGlsl(monaco: typeof Monaco): void {
  const exists = monaco.languages.getLanguages().some((l) => l.id === GLSL_LANGUAGE_ID);
  if (exists) return;
  monaco.languages.register({
    id: GLSL_LANGUAGE_ID,
    extensions: ['.glsl', '.vert', '.frag', '.vs', '.fs', '.vertex', '.fragment'],
    aliases: ['GLSL', 'glsl'],
  });
  monaco.languages.setMonarchTokensProvider(GLSL_LANGUAGE_ID, glslLanguage);
  monaco.languages.setLanguageConfiguration(GLSL_LANGUAGE_ID, glslLanguageConfig);
}
