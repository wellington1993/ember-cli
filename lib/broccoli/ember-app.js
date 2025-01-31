/* global require, module, escape */
'use strict';

/**
@module ember-cli
*/
var fs           = require('fs');
var existsSync   = require('exists-sync');
var path         = require('path');
var p            = require('ember-cli-preprocess-registry/preprocessors');
var chalk        = require('chalk');
var escapeRegExp = require('escape-string-regexp');
var EOL          = require('os').EOL;

var Project      = require('../models/project');
var cleanBaseURL = require('clean-base-url');
var SilentError  = require('silent-error');

var preprocessJs  = p.preprocessJs;
var preprocessCss = p.preprocessCss;
var isType        = p.isType;

var preprocessTemplates = p.preprocessTemplates;

var preprocessMinifyCss = p.preprocessMinifyCss;

var Babel  = require('broccoli-babel-transpiler');
var concat = require('broccoli-concat');

var ConfigReplace = require('broccoli-config-replace');
var ConfigLoader  = require('broccoli-config-loader');
var mergeTrees    = require('./merge-trees');
var WatchedDir    = require('broccoli-source').WatchedDir;
var UnwatchedDir  = require('broccoli-source').UnwatchedDir;

var defaults      = require('merge-defaults');
var merge         = require('lodash/merge');
var omitBy        = require('lodash/omitBy');
var isNull        = require('lodash/isNull');
var Funnel        = require('broccoli-funnel');
var funnelReducer = require('broccoli-funnel-reducer');

module.exports = EmberApp;

/**
  EmberApp is the main class Ember CLI uses to manage the Broccoli trees
  for your application. It is very tightly integrated with Broccoli and has
  an `toTree()` method you can use to get the entire tree for your application.

  Available init options:
    - es3Safe, defaults to `true`,
    - storeConfigInMeta, defaults to `true`,
    - autoRun, defaults to `true`,
    - outputPaths, defaults to `{}`,
    - minifyCSS, defaults to `{enabled: !!isProduction,options: { relativeTo: 'assets' }},
    - minifyJS, defaults to `{enabled: !!isProduction},
    - sourcemaps, defaults to `{}`,
    - trees, defaults to `{},`
    - jshintrc, defaults to `{},`
    - vendorFiles, defaults to `{}`

  @class EmberApp
  @constructor
  @param {Object} options Configuration options
*/
function EmberApp() {
  var args = [];
  var options = {};

  for (var i = 0, l = arguments.length; i < l; i++) {
    args.push(arguments[i]);
  }

  if (args.length === 1) {
    options = args[0];
  } else if (args.length > 1) {
    args.reverse();
    options = defaults.apply(null, args);
  }

  this._initProject(options);

  this.env  = EmberApp.env();
  this.name = options.name || this.project.name();

  this.registry = options.registry || p.defaultRegistry(this);

  this.bowerDirectory = this.project.bowerDirectory;

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this._initVendorFiles();

  this._styleOutputFiles       = {};
  this._scriptOutputFiles      = {};

  this.legacyFilesToAppend     = [];
  this.vendorStaticStyles      = [];
  this.otherAssetPaths         = [];
  this.legacyTestFilesToAppend = [];
  this.vendorTestStaticStyles  = [];

  this.trees = this.options.trees;

  this.populateLegacyFiles();
  p.setupRegistry(this);
  this._notifyAddonIncluded();

  if (!this._addonInstalled('loader.js') && !this.options._ignoreMissingLoader) {
    throw new SilentError('The loader.js addon is missing from your project, please add it to `package.json`.');
  }
}

/**
  @private
  @method _initTestsAndHinting
  @param {Object} options
  @param {Boolean} isProduction
*/
EmberApp.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

/**
  @private
  @method _initProject
  @param {Object} options
*/
EmberApp.prototype._initProject = function(options) {
  var app = this;

  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return app._resolveLocal(options.configPath); };
  }
};

/**
  @private
  @method _initOptions
  @param {Object} options
  @param {Boolean} isProduction
*/
EmberApp.prototype._initOptions = function(options, isProduction) {
  var babelOptions = { babel: {} };

  if (this._addonInstalled('ember-cli-babel')) {
    var amdNameResolver = require('amd-name-resolver').moduleResolve;
    babelOptions = {
      babel: {
        compileModules: true,
        modules: 'amdStrict',
        moduleIds: true,
        resolveModuleSource: amdNameResolver
      }
    };
  }

  var config = {
    es3Safe: true,
    storeConfigInMeta: true,
    autoRun: true,
    outputPaths: {},
    minifyCSS: {
      enabled: !!isProduction,
      options: { relativeTo: 'assets' }
    },
    minifyJS: {
      enabled: !!isProduction
    },
    sourcemaps: {},
    trees: {},
    jshintrc: {},
    'ember-cli-qunit': {
      disableContainerStyles: false
    },
    addons: {}
  };

  this.options = defaults(options, config, babelOptions);

  // needs a deeper merge than is provided above
  this.options.outputPaths = defaults(this.options.outputPaths, {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    tests: {
      js: '/assets/tests.js'
    },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    },
    testSupport: {
      css: '/assets/test-support.css',
      js: {
        testSupport: '/assets/test-support.js',
        testLoader: '/assets/test-loader.js'
      }
    }
  });

  this.options.sourcemaps = defaults(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  });

  // For now we must disable Babel sourcemaps due to unforseen
  // performance regressions.
  this.options.babel.sourceMaps = false;

  this.options.trees = defaults(this.options.trees, {
    app:       new WatchedDir(this._resolveLocal('app')),
    tests:     new WatchedDir(this._resolveLocal('tests')),

    // these are contained within app/ no need to watch again
    // (we should probably have the builder or the watcher dedup though)
    styles:    new UnwatchedDir(this._resolveLocal('app/styles')),
    templates: existsSync(this._resolveLocal('app/templates')) ? new UnwatchedDir(this._resolveLocal('app/templates')) : null,

    // do not watch vendor/ or bower's default directory by default
    bower: this.project._watchmanInfo.enabled ? this.bowerDirectory : new UnwatchedDir(this.bowerDirectory),
    vendor: existsSync(this._resolveLocal('vendor')) ? new UnwatchedDir(this._resolveLocal('vendor')) : null,

    public: existsSync(this._resolveLocal('public')) ? new WatchedDir(this._resolveLocal('public')) : null
  });

  this.options.jshintrc = defaults(this.options.jshintrc, {
    app: this.project.root,
    tests: this._resolveLocal('tests'),
  });
};

/**
  Resolves a path relative to the project's root

  @private
  @method _resolveLocal
*/
EmberApp.prototype._resolveLocal = function(to) {
  return path.join(this.project.root, to);
};

/**
  @private
  @method _initVendorFiles
*/
EmberApp.prototype._initVendorFiles = function() {
  var ember = this.project.findAddonByName('ember-core');
  var developmentEmber;
  var productionEmber;
  var emberShims;

  if (ember) {
    developmentEmber = ember.paths.debug;
    productionEmber = ember.paths.prod;
    emberShims      = ember.paths.shims;
  } else {
    emberShims = this.bowerDirectory + '/ember-cli-shims/app-shims.js';
    // in Ember 1.10 and higher `ember.js` is deprecated in favor of
    // the more aptly named `ember.debug.js`.
    productionEmber = this.bowerDirectory + '/ember/ember.prod.js';
    developmentEmber = this.bowerDirectory + '/ember/ember.debug.js';
    if (!existsSync(this._resolveLocal(developmentEmber))) {
      developmentEmber = this.bowerDirectory + '/ember/ember.js';
    }
  }

  var handlebarsVendorFiles;
  if ('handlebars' in this.project.bowerDependencies()) {
    handlebarsVendorFiles = {
      development: this.bowerDirectory + '/handlebars/handlebars.js',
      production:  this.bowerDirectory + '/handlebars/handlebars.runtime.js'
    };
  } else {
    handlebarsVendorFiles = null;
  }

  this.vendorFiles = omitBy(merge({
    'jquery.js': this.bowerDirectory + '/jquery/dist/jquery.js',
    'handlebars.js': handlebarsVendorFiles,
    'ember.js': {
      development: developmentEmber,
      production: productionEmber,
    },
    'ember-testing.js': [
      this.bowerDirectory + '/ember/ember-testing.js',
      { type: 'test' }
    ],
    'app-shims.js': emberShims,
    'ember-resolver.js': [
      this.bowerDirectory + '/ember-resolver/dist/modules/ember-resolver.js', {
        exports: {
          'ember/resolver': ['default']
        }
      }
    ]
  }, this.options.vendorFiles), isNull);

  if (this.registry.availablePlugins['ember-resolver']) {
    // if the project is using `ember-resolver` as an addon
    // remove it from `vendorFiles` (the NPM version properly works
    // without `app.import`s)
    delete this.vendorFiles['ember-resolver.js'];
  }

  // this is needed to support versions of Ember older than
  // 1.8.0 (when ember-testing.js was added to the deployment)
  if (this.vendorFiles['ember-testing.js'] && !existsSync(this.vendorFiles['ember-testing.js'][0])) {
    delete this.vendorFiles['ember-testing.js'];
  }
};

/**
  Returns the environment name

  @public
  @static
  @method env
  @return {String} Environment name
 */
EmberApp.env = function() {
  return process.env.EMBER_ENV || 'development';
};

/**
  Provides a broccoli files concatenation filter that's configured
  properly for this application.

  @method concatFiles
  @param tree
  @param options
  @return
*/
EmberApp.prototype.concatFiles = function(tree, options) {
  options.sourceMapConfig = this.options.sourcemaps;

  return concat(tree, options);
};

/**
  @private
  @method _addonEnabled
  @param {Addon} addon
  @return {Boolean}
*/
EmberApp.prototype._addonEnabled = function(addon) {
  return !addon.isEnabled || addon.isEnabled();
};

/**
  @private
  @method _addonDisabledByBlacklist
  @param {Addon} addon
  @return {Boolean}
*/
EmberApp.prototype._addonDisabledByBlacklist = function(addon) {
  var blacklist = this.options.addons.blacklist;
  return !!blacklist && blacklist.indexOf(addon.name) !== -1;
};

/**
  @private
  @method _addonDisabledByWhitelist
  @param {Addon} addon
  @return {Boolean}
*/
EmberApp.prototype._addonDisabledByWhitelist = function(addon) {
  var whitelist = this.options.addons.whitelist;
  return !!whitelist && whitelist.indexOf(addon.name) === -1;
};

/**
  Returns whether an addon should be added to the project

  @private
  @method shouldIncludeAddon
  @param {Addon} addon
  @return {Boolean}
*/
EmberApp.prototype.shouldIncludeAddon = function(addon) {
  var enabled = this._addonEnabled(addon);
  var disabledByBlacklist = this._addonDisabledByBlacklist(addon);
  var disabledByWhitelist = this._addonDisabledByWhitelist(addon);

  var notDisabledByBlackOrWhitelist = !(disabledByBlacklist || disabledByWhitelist);

  return notDisabledByBlackOrWhitelist && enabled;
};



/**
  @private
  @method _notifyAddonIncluded
*/
EmberApp.prototype._notifyAddonIncluded = function() {
  this.initializeAddons();

  var addonNames = this.project.addons.map(function(addon) {
    return addon.name;
  });

  if (this.options.addons.blacklist) {
    this.options.addons.blacklist.forEach(function(addonName) {
      if (addonNames.indexOf(addonName) === -1) {
        throw new Error('Addon "' + addonName + '" defined in blacklist is not found');
      }
    });
  }

  if (this.options.addons.whitelist) {
    this.options.addons.whitelist.forEach(function(addonName) {
      if (addonNames.indexOf(addonName) === -1) {
        throw new Error('Addon "' + addonName + '" defined in whitelist is not found');
      }
    });
  }

  this.project.addons = this.project.addons.filter(function(addon) {
    addon.app = this;

    if (this.shouldIncludeAddon(addon)) {
      if (addon.included) {
        addon.included(this);
      }

      return addon;
    }
  }, this);
};

/**
  Loads and initializes addons for this project.
  Calls initializeAddons on the Project.

  @private
  @method initializeAddons
*/
EmberApp.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

/**
  Returns a list of trees for a given type, returned by all addons.

  @private
  @method addonTreesFor
  @param  {String} type Type of tree
  @return {Array}       List of trees
 */
EmberApp.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      return addon.treeFor(type);
    }
  }).filter(Boolean);
};

/**
  Runs addon postprocessing on a given tree and returns the processed tree.

  This enables addons to do process immediately **after** the preprocessor for a
  given type is run, but before concatenation occurs. If an addon wishes to
  apply a transform before the preprocessors run, they can instead implement the
  preprocessTree hook.

  To utilize this addons implement `postprocessTree` hook.

  An example, would be to apply some broccoli transform on all JS files, but
  only after the existing pre-processors have fun.

  ```js
  module.exports = {
    name: 'my-cool-addon',
    postprocessTree: function(type, tree) {
      if (type === 'js') {
        return someBroccoliTransform(tree);
      }

      return tree;
    }
  }

  ```

  @private
  @method addonPostprocessTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;

  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });

  return workingTree;
};


/**
  Runs addon postprocessing on a given tree and returns the processed tree.

  This enables addons to do process immediately **before** the preprocessor for a
  given type is run, but before concatenation occurs.  If an addon wishes to
  apply a transform  after the preprocessors run, they can instead implement the
  postprocessTree hook.

  To utilize this addons implement `postprocessTree` hook.

  An example, would be to remove some set of files before the preprocessors run.

  ```js
  var stew = require('broccoli-stew');

  module.exports = {
    name: 'my-cool-addon',
    preprocessTree: function(type, tree) {
      if (type === 'js' && type === 'template') {
        return stew.rm(tree, someGlobPattern);
      }

      return tree;
    }
  }
  ```

  @private
  @method addonPreprocessTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonPreprocessTree = function(type, tree) {
  var workingTree = tree;

  this.project.addons.forEach(function(addon) {
    if (addon.preprocessTree) {
      workingTree = addon.preprocessTree(type, workingTree);
    }
  });

  return workingTree;
};

/**
  Runs addon lintTree hooks and returns a single tree containing all
  their output.

  @private
  @method addonLintTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonLintTree = function(type, tree) {
  var output = this.project.addons.map(function(addon) {
    if (addon.lintTree) {
      return addon.lintTree(type, tree);
    }
  }).filter(Boolean);

  return mergeTrees(output, {
    overwrite: true,
    annotation: 'TreeMerger (lint)'
  });
};

/**
  Imports legacy imports in this.vendorFiles

  @private
  @method populateLegacyFiles
*/
EmberApp.prototype.populateLegacyFiles = function () {
  var name;
  for (name in this.vendorFiles) {
    var args = this.vendorFiles[name];

    if (args === null) { continue; }

    this.import.apply(this, [].concat(args));
  }
};

/**
  Returns the tree for app/index.html

  @private
  @method index
  @return {Tree} Tree for app/index.html
*/
EmberApp.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var files = [
    'index.html'
  ];

  var index = new Funnel(this.trees.app, {
    files: files,
    getDestinationPath: function(relativePath) {
      if (relativePath === 'index.html') {
        relativePath = htmlName;
      }
      return relativePath;
    },
    annotation: 'Funnel: index.html'
  });

  return new ConfigReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  });
};

/**
  @private
  @method _filterAppTree
  @return tree
*/
EmberApp.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  var podPatterns = this._podTemplatePatterns();
  var excludePatterns = podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    'styles/**/*',
    'templates/**/*',
  ]);

  this._cachedFilterAppTree = new Funnel(this.trees.app, {
    exclude: excludePatterns,
    annotation: 'Funnel: Filtered App'
  });

  return this._cachedFilterAppTree;
};

/**

 */
EmberApp.prototype._templatesTree = function() {
  if (this._cachedTemplateTree) {
    return this._cachedTemplateTree;
  }

  var trees = [];
  if (this.trees.templates) {
    var standardTemplates = new Funnel(this.trees.templates, {
      srcDir: '/',
      destDir: this.name + '/templates',
      annotation: 'Funnel: Templates'
    });

    trees.push(standardTemplates);
  }

  if (this.trees.app) {
    var podTemplates = new Funnel(this.trees.app, {
      include: this._podTemplatePatterns(),
      exclude: [ 'templates/**/*' ],
      destDir: this.name + '/',
      annotation: 'Funnel: Pod Templates'
    });

    trees.push(podTemplates);
  }

  this._cachedTemplateTree = mergeTrees(trees, {
    annotation: 'TreeMerge (templates)'
  });

  return this._cachedTemplateTree;
};

/**
  @private
  @method _configReplacePatterns
  @return
*/
EmberApp.prototype._configReplacePatterns = function() {
  return [{
    match: /\{\{EMBER_ENV\}\}/g,
    replacement: calculateEmberENV
  }, {
    match: /\{\{content-for ['"](.+)["']\}\}/g,
    replacement: this.contentFor.bind(this)
  }, {
    match: /\{\{MODULE_PREFIX\}\}/g,
    replacement: calculateModulePrefix
  }];
};

/**
  Returns the tree for /tests/index.html

  @private
  @method testIndex
  @return {Tree} Tree for /tests/index.html
 */
EmberApp.prototype.testIndex = function() {
  var index = new Funnel(this.trees.tests, {
    srcDir: '/',
    files: ['index.html'],
    destDir: '/tests',
    annotation: 'Funnel (test index)'
  });

  return new ConfigReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ 'tests/index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  });
};

/**
  Returns the tree for /public

  @private
  @method publicTree
  @return {Tree} Tree for /public
 */
EmberApp.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public');

  if (this.trees.public) {
    trees.push(this.trees.public);
  }

  return mergeTrees(trees, {
    overwrite: true,
    annotation: 'TreeMerge (public)'
  });
};


/**
  @private
  @method _processedAppTree
  @return
*/
EmberApp.prototype._processedAppTree = function() {
  var addonTrees = this.addonTreesFor('app');
  var mergedApp  = mergeTrees(addonTrees.concat(this._filterAppTree()), {
    overwrite: true,
    annotation: 'TreeMerger (app)'
  });

  return new Funnel(mergedApp, {
    srcDir: '/',
    destDir: this.name,
    annotation: 'ProcessedAppTree'
  });
};

/**
  @private
  @method _processedTemplatesTree
  @return
*/
EmberApp.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var mergedTemplates = mergeTrees(addonTrees, {
    overwrite: true,
    annotation: 'TreeMerger (templates)'
  });

  var addonTemplates = new Funnel(mergedTemplates, {
    srcDir: '/',
    destDir: this.name + '/templates',
    annotation: 'ProcessedTemplateTree'
  });

  var combinedTemplates = mergeTrees([
    addonTemplates,
    this._templatesTree()
  ], {
    annotation: 'addonPreprocessTree(template)',
    overwrite: true
  });

  var templates = this.addonPreprocessTree('template', combinedTemplates);

  return this.addonPostprocessTree('template', preprocessTemplates(templates, {
    registry: this.registry,
    annotation: 'TreeMerger (pod & standard templates)'
  }));
};

/**
  @private
  @method _podTemplatePatterns
  @returns Array An array of regular expressions.
*/
EmberApp.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return '**/*/template.' + extension;
  });
};

/**
  @private
  @method _processedTestsTree
  @return
*/
EmberApp.prototype._processedTestsTree = function() {
  var addonTrees  = this.addonTreesFor('test-support');
  var mergedTests = mergeTrees(addonTrees.concat(this.trees.tests), {
    overwrite: true,
    annotation: 'TreeMerger (tests)'
  });

  return new Funnel(mergedTests, {
    srcDir: '/',
    destDir: this.name + '/tests',
    annotation: 'ProcessedTestTree'
  });
};

/**
  @private
  @method _processedBowerTree
  @return
*/
EmberApp.prototype._processedBowerTree = function() {
  if (this._cachedBowerTree) {
    return this._cachedBowerTree;
  }

  // do not attempt to merge bower and vendor together
  // if they are the same tree
  if (this.bowerDirectory === 'vendor') {
    return;
  }

  this._cachedBowerTree = new Funnel(this.trees.bower, {
    srcDir: '/',
    destDir: this.bowerDirectory + '/',
    annotation: 'Funnel (bower)'
  });

  return this._cachedBowerTree;
};

/**

*/
EmberApp.prototype._addonTree = function _addonTree() {
  if (this._cachedAddonTree) {
    return this._cachedAddonTree;
  }

  var addonTrees = mergeTrees(this.addonTreesFor('addon'), {
    overwrite: true,
    annotation: 'TreeMerger (addons)'
  });

  var addonES6 = new Funnel(addonTrees, {
    srcDir: 'modules',
    allowEmpty: true,
    annotation: 'Funnel: Addon JS'
  });

  var transpiledAddonTree = new Babel(addonES6, this._prunedBabelOptions());
  var trees = [ transpiledAddonTree ];

  var reexportsAndTranspiledAddonTree = mergeTrees(trees, {
    annotation: 'TreeMerger: (re-exports)'
  });

  return this._cachedAddonTree = [
    this.concatFiles(addonTrees, {
      inputFiles: ['**/*.css'],
      outputFile: '/addons.css',
      allowNone: true,
      annotation: 'Concat: Addon CSS'
    }),

    this.concatFiles(reexportsAndTranspiledAddonTree, {
      inputFiles: ['**/*.js'],
      outputFile: '/addons.js',
      allowNone: true,
      annotation: 'Concat: Addon JS'
    })
  ];
};

/**
  @private
  @method _processedVendorTree
  @return
*/
EmberApp.prototype._processedVendorTree = function() {
  if (this._cachedVendorTree) {
    return this._cachedVendorTree;
  }

  var trees = this._addonTree();
  trees = trees.concat(this.addonTreesFor('vendor'));

  if (this.trees.vendor) {
    trees.push(this.trees.vendor);
  }

  var mergedVendor = mergeTrees(trees, {
    overwrite: true,
    annotation: 'TreeMerger (vendor)'
  });

  this._cachedVendorTree = new Funnel(mergedVendor, {
    srcDir: '/',
    destDir: 'vendor/',
    annotation: 'Funnel (vendor)'
  });

  return this._cachedVendorTree;
};

/**
  @private
  @method _processedExternalTree
  @return
*/
EmberApp.prototype._processedExternalTree = function() {
  if (this._cachedExternalTree) {
    return this._cachedExternalTree;
  }

  var vendor = this._processedVendorTree();
  var bower = this._processedBowerTree();

  var trees = [vendor];
  if (bower) {
    trees.unshift(bower);
  }

  return this._cachedExternalTree = mergeTrees(trees, {
    annotation: 'TreeMerger (ExternalTree)'
  });
};

/**
  @private
  @method _configTree
  @return
*/
EmberApp.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = new ConfigLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = new Funnel(configTree, {
    srcDir: '/',
    destDir: this.name + '/config',
    annotation: 'Funnel (config)'
  });

  return this._cachedConfigTree;
};

/**
  @private
  @method _processedEmberCLITree
  @return
*/
EmberApp.prototype._processedEmberCLITree = function() {
  if (this._cachedEmberCLITree) {
    return this._cachedEmberCLITree;
  }

  var files = [
    'vendor-prefix.js',
    'vendor-suffix.js',
    'app-prefix.js',
    'app-suffix.js',
    'app-config.js',
    'app-boot.js',
    'test-support-prefix.js',
    'test-support-suffix.js',
    'tests-suffix.js'
  ];
  var emberCLITree = new ConfigReplace(new UnwatchedDir(__dirname), this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: files,

    patterns: this._configReplacePatterns()
  });

  return this._cachedEmberCLITree = new Funnel(emberCLITree, {
    files: files,
    srcDir: '/',
    destDir: '/vendor/ember-cli/',
    annotation: 'Funnel (ember-cli-tree)'
  });
};

/**
  Returns the tree for the app and its dependencies

  @private
  @method appAndDependencies
  @return {Tree} Merged tree
*/
EmberApp.prototype.appAndDependencies = function() {
  var sourceTrees = [];
  var config = this._configTree();
  var app;
  var templates = this._processedTemplatesTree();

  app = this.addonPreprocessTree('js', mergeTrees([
    this._processedAppTree(),
    templates
  ].concat(sourceTrees), {
    annotation: 'TreeMerger (preprocessedApp & templates)',
    overwrite: true
  }));

  var external        = this._processedExternalTree();
  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);
  sourceTrees = sourceTrees.concat([
    external,
    postprocessedApp,
    config
  ]);

  var emberCLITree = this._processedEmberCLITree();

  sourceTrees.push(emberCLITree);

  return mergeTrees(sourceTrees, {
    overwrite: true,
    annotation: 'TreeMerger (appAndDependencies)'
  });
};

EmberApp.prototype.test = function() {
  var tests = this.addonPreprocessTree('test', this._processedTestsTree());
  var preprocessedTests = preprocessJs(tests, '/tests', this.name, {
    registry: this.registry
  });
  var coreTestTree = this.addonPostprocessTree('test', preprocessedTests);

  var appTestTree = this.appTests(coreTestTree);
  var testFilesTree = this.testFiles(coreTestTree);

  return mergeTrees([appTestTree, testFilesTree]);
};

/**
  @private
  @method appTests
*/
EmberApp.prototype.appTests = function(coreTestTree) {
  var appTestTrees = [coreTestTree];

  if (this.hinting) {
    var lintedApp = this.addonLintTree('app', this._filterAppTree());
    var lintedTests = this.addonLintTree('tests', this.trees.tests);
    var lintedTemplates = this.addonLintTree('templates', this._templatesTree());

    lintedApp = new Babel(new Funnel(lintedApp, {
      srcDir: '/',
      destDir: this.name + '/tests/',
      annotation: 'Funnel (lint app)'
    }), this._prunedBabelOptions());

    lintedTests = new Babel(new Funnel(lintedTests, {
      srcDir: '/',
      destDir: this.name + '/tests/',
      annotation: 'Funnel (lint tests)'
    }), this._prunedBabelOptions());

    lintedTemplates = new Babel(new Funnel(lintedTemplates, {
      srcDir: '/',
      destDir: this.name + '/tests/',
      annotation: 'Funnel (lint templates)'
    }), this._prunedBabelOptions());

    appTestTrees.push(lintedApp);
    appTestTrees.push(lintedTests);
    appTestTrees.push(lintedTemplates);
  }

  appTestTrees.push(this._processedEmberCLITree());

  appTestTrees = mergeTrees(appTestTrees, {
    overwrite: true,
    annotation: 'TreeMerger (appTestTrees)'
  });

  return this.concatFiles(appTestTrees, {
    inputFiles: [ this.name + '/tests/**/*.js' ],
    footerFiles: [ 'vendor/ember-cli/tests-suffix.js' ],
    outputFile: this.options.outputPaths.tests.js,
    annotation: 'Concat: App Tests'
  });
};

/**
 * @private
 * @param  {String} addonName The name of the addon we are checking to see if it's installed
 * @return {Boolean}
 */
EmberApp.prototype._addonInstalled = function(addonName) {
  return !!this.registry.availablePlugins[addonName];
};

/**
 * @private
 *
 * Prunes ember-cli-babel options
 * @return {Object} The pruned babel-options
 */
EmberApp.prototype._prunedBabelOptions = function() {
  var babelOptions = merge({}, this.options.babel);
  delete babelOptions.compileModules;
  delete babelOptions.includePolyfill;
  return babelOptions;
};

/**
  Returns the tree for javascript files

  @private
  @method javascript
  @return {Tree} Merged tree
*/
EmberApp.prototype.javascript = function() {
  var deprecate           = this.project.ui.writeDeprecateLine.bind(this.project.ui);
  var applicationJs       = this.appAndDependencies();
  var appOutputPath       = this.options.outputPaths.app.js;
  var appJs               = applicationJs;

  // Note: If ember-cli-babel is installed we have already performed the transpilation at this point
  if (!this._addonInstalled('ember-cli-babel')) {
    appJs = new Babel(
      new Funnel(applicationJs, {
        include: [escapeRegExp(this.name + '/') + '**/*.js'],
        annotation: 'Funnel: App JS Files'
      }),
      merge(this._prunedBabelOptions())
    );
  }

  appJs = mergeTrees([
    appJs,
    this._processedEmberCLITree()
  ], {
    annotation: 'TreeMerger (appJS  & processedEmberCLITree)',
    overwrite: true
  });

  appJs = this.concatFiles(appJs, {
    inputFiles: [this.name + '/**/*.js'],
    headerFiles: [
      'vendor/ember-cli/app-prefix.js'
    ],
    footerFiles: [
      'vendor/ember-cli/app-suffix.js',
      'vendor/ember-cli/app-config.js',
      'vendor/ember-cli/app-boot.js'
    ],
    outputFile: appOutputPath,
    annotation: 'Concat: App'
  });

  if (this.legacyFilesToAppend.length > 0) {
    deprecate('Usage of EmberApp.legacyFilesToAppend is deprecated. Please use EmberApp.import instead for the following files: \'' + this.legacyFilesToAppend.join('\', \'') + '\'');
    this.legacyFilesToAppend.forEach(function(legacyFile) {
      this.import(legacyFile);
    }.bind(this));
  }

  this.import('vendor/ember-cli/vendor-prefix.js', {prepend: true});
  this.import('vendor/addons.js');
  this.import('vendor/ember-cli/vendor-suffix.js');

  var vendorFiles = [];
  for (var outputFile in this._scriptOutputFiles) {
    var inputFiles = this._scriptOutputFiles[outputFile];

    vendorFiles.push(
      this.concatFiles(applicationJs, {
        inputFiles: inputFiles,
        outputFile: outputFile,
        separator: EOL + ';',
        annotation: 'Concat: Vendor ' + outputFile
      })
    );
  }

  return mergeTrees(vendorFiles.concat(appJs), {
    annotation: 'TreeMerger (vendor & appJS)'
  });
};

/**
  Returns the tree for styles

  @private
  @method styles
  @return {Tree} Merged tree for styles
*/
EmberApp.prototype.styles = function() {
  if (this._processedStylesTree) {
    return this._processedStylesTree;
  }

  if (existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var deprecate = this.project.ui.writeDeprecateLine.bind(this.project.ui);
  var addonTrees = this.addonTreesFor('styles');
  var external = this._processedExternalTree();
  var styles = new Funnel(this.trees.styles, {
    srcDir: '/',
    destDir: '/app/styles',
    annotation: 'Funnel (styles)'
  });

  var trees = [external].concat(addonTrees);
  trees.push(styles);

  var options = { outputPaths: this.options.outputPaths.app.css };
  options.registry = this.registry;

  var stylesAndVendor = this.addonPreprocessTree('css', mergeTrees(trees, {
    annotation: 'TreeMerger (stylesAndVendor)',
    overwrite: true
  }));

  var preprocessedStyles = preprocessCss(stylesAndVendor, '/app/styles', '/assets', options);

  if (this.vendorStaticStyles.length > 0) {
    deprecate('Usage of EmberApp.vendorStaticStyles is deprecated. Please use EmberApp.import instead for the following files: \'' + this.vendorStaticStyles.join('\', \'') + '\'');
    this.vendorStaticStyles.forEach(function(filename) {
      this.import(filename);
    }.bind(this));
  }

  this.import('vendor/addons.css');

  var vendorStyles = [];
  for (var outputFile in this._styleOutputFiles) {
    var inputFiles = this._styleOutputFiles[outputFile];

    vendorStyles.push(this.concatFiles(stylesAndVendor, {
      inputFiles: inputFiles,
      outputFile: outputFile,
      annotation: 'Concat: Vendor Styles' + outputFile
    }));
  }

  vendorStyles = this.addonPreprocessTree('css', mergeTrees(vendorStyles, {
    annotation: 'TreeMerger (vendorStyles)',
    overwrite: true
  }));

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
    vendorStyles    = preprocessMinifyCss(vendorStyles, options);
  }

  var mergedTrees = mergeTrees([
    preprocessedStyles,
    vendorStyles
  ], {
    annotation: 'styles'
  });

  return this._processedStylesTree = this.addonPostprocessTree('css', mergedTrees);
};

/**
  Returns the tree for test files

  @private
  @method testFiles
  @return {Tree} Merged tree for test files
 */
EmberApp.prototype.testFiles = function(coreTestTree) {
  var testSupportPath = this.options.outputPaths.testSupport.js;
  var testLoaderPath = this.options.outputPaths.testSupport.js.testLoader;

  testSupportPath = testSupportPath.testSupport || testSupportPath;

  var external = this._processedExternalTree();
  var emberCLITree = this._processedEmberCLITree();

  var addonTestSupportTree = mergeTrees(this.addonTreesFor('addon-test-support'), {
    overwrite: true,
    annotation: 'TreeMerger (addon-test-support)'
  });
  var transpiledAddonTestSupportTree = new Babel(addonTestSupportTree, this._prunedBabelOptions());

  var finalAddonTestSupportTree = new Funnel(transpiledAddonTestSupportTree, {
    allowEmpty: true,
    destDir: 'addon-test-support',
    annotation: 'Funnel: Addon Test Support'
  });

  var headerFiles = [].concat(
    'vendor/ember-cli/test-support-prefix.js',
    this.legacyTestFilesToAppend
  );

  var inputFiles = ['addon-test-support/**/*.js'];

  var footerFiles = ['vendor/ember-cli/test-support-suffix.js'];

  var baseMergedTree = mergeTrees([emberCLITree, external, coreTestTree, finalAddonTestSupportTree]);
  var testJs = this.concatFiles(baseMergedTree, {
    headerFiles: headerFiles,
    inputFiles: inputFiles,
    footerFiles: footerFiles,
    outputFile: testSupportPath,
    annotation: 'Concat: Test Support JS',
    allowNone: true
  });

  var testemPath = path.join(__dirname, 'testem');
  testemPath = path.dirname(testemPath);

  var testemTree = new Funnel(new UnwatchedDir(testemPath), {
    files: ['testem.js'],
    srcDir: '/',
    destDir: '/',
    annotation: 'Funnel (testem)'
  });

  if (this.options.fingerprint && this.options.fingerprint.exclude) {
    this.options.fingerprint.exclude.push('testem');
  }

  var testLoader = new Funnel(external, {
    files: ['test-loader.js'],
    srcDir: '/' + this.bowerDirectory + '/ember-cli-test-loader',
    destDir: path.dirname(testLoaderPath),
    annotation: 'Funnel (testLoader)'
  });

  var sourceTrees = [
    testemTree,
    testJs,
    testLoader
  ];

  if (this.vendorTestStaticStyles.length > 0) {
    sourceTrees.push(
      this.concatFiles(external, {
        inputFiles: this.vendorTestStaticStyles,
        outputFile: this.options.outputPaths.testSupport.css,
        annotation: 'Concat: Test Support CSS'
      })
    );
  }

  return mergeTrees(sourceTrees, {
    overwrite: true,
    annotation: 'TreeMerger (testFiles)'
  });
};

/**
  Returns the tree for the additional assets which are not in
  one of the default trees.

  @private
  @method otherAssets
  @return {Tree} Merged tree for other assets
 */
EmberApp.prototype.otherAssets = function() {
  var external = this._processedExternalTree();
  // combine obviously shared funnels.
  var otherAssetTrees = funnelReducer(this.otherAssetPaths).map(function(options) {
    options.annotation = 'Funnel \n  ' +
      options.srcDir + '\n  ' +
      options.destDir + '\n include:' +
      options.include.length;

    return new Funnel(external, options);
  });

  return mergeTrees(otherAssetTrees, {
    annotation: 'TreeMerger (otherAssetTrees)'
  });
};

/**
  @public
  @method dependencies
  @return {Object} Alias to the project's dependencies function
*/
EmberApp.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

/**
  Imports an asset into the application.

  Options:
  - type - Either 'vendor' or 'test', defaults to 'vendor'
  - prepend - Whether or not this asset should be prepended, defaults to false
  - destDir - Destination directory, defaults to the name of the directory the asset is in

  @public
  @method import
  @param  {(Object|String)}  asset   Either a path to the asset or an object with environment names and paths as key-value pairs.
  @param  {Object=} options Options object
 */
EmberApp.prototype.import = function(asset, options) {
  var assetPath = this._getAssetPath(asset);

  if (!assetPath) {
    return;
  }

  options = defaults(options || {}, {
    type: 'vendor',
    prepend: false
  });

  var directory    = path.dirname(assetPath);
  var subdirectory = directory.replace(new RegExp('^vendor/|' + this.bowerDirectory), '');
  var extension    = path.extname(assetPath);

  if (!extension) {
    throw new Error('You must pass a file to `app.import`. For directories specify them to the constructor under the `trees` option.');
  }

  this._import(
    assetPath,
    options,
    directory,
    subdirectory,
    extension
  );
};

/**
  @private
  @method _import
  @param {String} assetPath
  @param {Object} options
  @param {String} directory
  @param {String} subdirectory
  @param {String} extension
 */
EmberApp.prototype._import = function(assetPath, options, directory, subdirectory, extension) {
  var basename = path.basename(assetPath);

  if (isType(assetPath, 'js', {registry: this.registry})) {
    if (options.type === 'vendor') {
      options.outputFile = options.outputFile || this.options.outputPaths.vendor.js;
      addOutputFile(this._scriptOutputFiles, assetPath, options);
    } else if (options.type === 'test') {
      if (options.prepend) {
        this.legacyTestFilesToAppend.unshift(assetPath);
      } else {
        this.legacyTestFilesToAppend.push(assetPath);
      }
    } else {
      throw new Error('You must pass either `vendor` or `test` for options.type in your call to `app.import` for file: ' + basename);
    }
  } else if (extension === '.css') {
    if (options.type === 'vendor') {
      options.outputFile = options.outputFile || this.options.outputPaths.vendor.css;
      addOutputFile(this._styleOutputFiles, assetPath, options);
    } else {
      this.vendorTestStaticStyles.push(assetPath);
    }
  } else {
    var destDir = options.destDir;
    if (destDir === '') {
      destDir = '/';
    }
    this.otherAssetPaths.push({
      src: directory,
      file: basename,
      dest: destDir || subdirectory
    });
  }
};

/**
  @private
  @method _getAssetPath
  @param {(Object|String)} asset
  @return {(String|undefined)} assetPath
 */
EmberApp.prototype._getAssetPath = function(asset) {
  /** @type {String} */
  var assetPath;

  if (typeof asset === 'object') {
    if (this.env in asset) {
      assetPath = asset[this.env];
    } else {
      assetPath = asset.development;
    }
  } else {
    assetPath = asset;
  }

  if (!assetPath) {
    return;
  }

  assetPath = assetPath.replace(path.sep, '/');

  if (assetPath.split('/').length < 2) {
    console.log(chalk.red('Using `app.import` with a file in the root of `vendor/` causes a significant performance penalty. Please move `' + assetPath + '` into a subdirectory.'));
  }

  if (/[\*\,]/.test(assetPath)) {
    throw new Error('You must pass a file path (without glob pattern) to `app.import`.  path was: `' + assetPath + '`');
  }

  return assetPath;
};

/**
  Returns an array of trees for this application

  @private
  @method toArray
  @return {Array} An array of trees
 */
EmberApp.prototype.toArray = function() {
  var sourceTrees = [
    this.index(),
    this.javascript(),
    this.styles(),
    this.otherAssets(),
    this.publicTree()
  ];

  if (this.tests) {
    sourceTrees = sourceTrees.concat(this.testIndex(), this.test());
  }

  return sourceTrees;
};

/**
  Returns the merged tree for this application

  @public
  @method toTree
  @param  {Array} additionalTrees Array of additional trees to merge
  @return {Tree}                  Merged tree for this application
 */
EmberApp.prototype.toTree = function(additionalTrees) {
  var tree = mergeTrees(this.toArray().concat(additionalTrees || []), {
    overwrite: true,
    annotation: 'TreeMerger (allTrees)'
  });

  return this.addonPostprocessTree('all', tree);
};

/**
  Returns the content for a specific type (section) for index.html.

  Currently supported types:
  - 'head'
  - 'config-module'
  - 'app'
  - 'head-footer'
  - 'test-header-footer'
  - 'body-footer'
  - 'test-body-footer'

  Addons can also implement this method and could also define additional
  types (eg. 'some-addon-section').

  @private
  @method contentFor
  @param  {Object} config Application configuration
  @param  {RegExp} match  Regular expression to match against
  @param  {String} type   Type of content
  @return {String}        The content.
 */
EmberApp.prototype.contentFor = function(config, match, type) {
  var content = [];
  var deprecatedHooks = ['app-prefix', 'app-suffix', 'vendor-prefix', 'vendor-suffix'];
  var deprecate = this.project.ui.writeDeprecateLine.bind(this.project.ui);

  switch (type) {
    case 'head':             this._contentForHead(content, config);           break;
    case 'config-module':    this._contentForConfigModule(content, config);   break;
    case 'app-boot':         this._contentForAppBoot(content, config);        break;
    case 'test-body-footer': this._contentForTestBodyFooter(content); break;
  }

  content = this.project.addons.reduce(function(content, addon) {
    var addonContent = addon.contentFor ? addon.contentFor(type, config, content) : null;
    if (addonContent) {
      deprecate('The `' + type + '` hook used in ' + addon.name + ' is deprecated. The addon should generate a module and have consumers `require` it.', !~deprecatedHooks.indexOf(type));
      return content.concat(addonContent);
    }

    return content;
  }, content);

  return content.join('\n');
};

/**
  @private
  @method _contentForTestBodyFooter
  @param {Array} content
*/
EmberApp.prototype._contentForTestBodyFooter = function(content) {
  content.push('<script>Ember.assert(\'The tests file was not loaded. Make sure your tests index.html includes "assets/tests.js".\', EmberENV.TESTS_FILE_LOADED);</script>');
};

/**
  @private
  @method _contentForHead
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

/**
  @private
  @method _contentForConfigModule
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    content.push(fs.readFileSync(path.join(__dirname, 'app-config-from-meta.js')));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

/**
  @private
  @method _contentForAppBoot
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForAppBoot = function(content, config) {
  if (this.options.autoRun) {
    content.push('if (!runningTests) {');
    content.push('  require("' +
      config.modulePrefix +
      '/app")["default"].create(' +
      calculateAppConfig(config) +
      ');');
    content.push('}');
  }
};

/**
  Returns the <base> tag for index.html

  @param  {Object} config Application configuration
  @return {String}        Base tag or empty string
 */
function calculateBaseTag(config) {
  var baseURL      = cleanBaseURL(config.baseURL);
  var locationType = config.locationType;

  if (locationType === 'hash') {
    return '';
  }

  if (baseURL) {
    return '<base href="' + baseURL + '" />';
  } else {
    return '';
  }
}

function calculateEmberENV(config) {
  return JSON.stringify(config.EmberENV || {});
}

function calculateAppConfig(config) {
  return JSON.stringify(config.APP || {});
}

function calculateModulePrefix(config) {
  return config.modulePrefix;
}

function addOutputFile(container, assetPath, options) {
  var outputFile = options.outputFile;

  if (!outputFile) {
    throw new Error('outputFile is not specified');
  }

  if (!container[outputFile]) {
    container[outputFile] = [];
  }

  if (options.prepend) {
    container[outputFile].unshift(assetPath);
  } else {
    container[outputFile].push(assetPath);
  }
}
