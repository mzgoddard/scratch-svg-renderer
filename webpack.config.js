const defaultsDeep = require('lodash.defaultsdeep');
const path = require('path');

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'cheap-module-source-map',
    entry: {
        'scratch-svg-renderer': './src/index.js'
    },
    output: {
        library: 'ScratchSVGRenderer',
        filename: '[name].js'
    },
    module: {
        rules: [{
            include: path.resolve('src'),
            test: /\.js$/,
            loader: 'babel-loader',
            options: {
                presets: [['env', {targets: {}}]]
            }
        }]
    }
};

module.exports = [
    defaultsDeep(base, {
        output: {
            libraryTarget: 'umd',
            path: path.resolve('dist', 'web')
        },
        module: {
            rules: [{
                options: {
                    presets: [['env', {targets: {browsers: ['last 3 versions', 'Safari >= 8', 'iOS >= 8']}}]]
                }
            }]
        },
        optimization: {
            minimize: process.env.NODE_ENV === 'production'
        }
    }),
    // For testing only: many features will fail outside a browser
    defaultsDeep(base, {
        output: {
            libraryTarget: 'commonjs2',
            path: path.resolve('dist', 'node')
        },
        module: {
            rules: [{
                options: {
                    presets: [['env', {targets: {node: true, uglify: true}}]]
                }
            }]
        },
        performance: {
            hints: false
        },
        optimization: {
            minimize: false
        }
    })
];
