// babel.config.cjs — named .cjs because package.json declares "type":"module"
// which would otherwise cause Node to parse a plain .js config as ESM,
// breaking the module.exports syntax Jest needs.
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
  ],
};
