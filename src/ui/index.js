import { format as formatUrl } from 'url';
import { readFileSync as readFile } from 'fs';
import { defaults } from 'lodash';
import Boom from 'boom';
import { resolve } from 'path';
import fromRoot from '../utils/from_root';
import UiExports from './ui_exports';
import UiBundle from './ui_bundle';
import UiBundleCollection from './ui_bundle_collection';
import UiBundlerEnv from './ui_bundler_env';

export default async (kbnServer, server, config) => {
  const uiExports = kbnServer.uiExports = new UiExports({
    urlBasePath: config.get('server.basePath')
  });

  const bundlerEnv = new UiBundlerEnv(config.get('optimize.bundleDir'));
  bundlerEnv.addContext('env', config.get('env.name'));
  bundlerEnv.addContext('urlBasePath', config.get('server.basePath'));
  bundlerEnv.addContext('sourceMaps', config.get('optimize.sourceMaps'));
  bundlerEnv.addContext('kbnVersion', config.get('pkg.version'));
  bundlerEnv.addContext('buildNum', config.get('pkg.buildNum'));
  uiExports.addConsumer(bundlerEnv);

  for (let plugin of kbnServer.plugins) {
    uiExports.consumePlugin(plugin);
  }

  const bundles = kbnServer.bundles = new UiBundleCollection(bundlerEnv, config.get('optimize.bundleFilter'));

  for (let app of uiExports.getAllApps()) {
    bundles.addApp(app);
  }

  for (let gen of uiExports.getBundleProviders()) {
    const bundle = await gen(UiBundle, bundlerEnv, uiExports.getAllApps(), kbnServer.plugins);
    if (bundle) bundles.add(bundle);
  }

  // render all views from the ui/views directory
  server.setupViews(resolve(__dirname, 'views'));

  server.route({
    path: '/app/{id}',
    method: 'GET',
    handler: function (req, reply) {
      const id = req.params.id;
      const app = uiExports.apps.byId[id];
      if (!app) return reply(Boom.notFound('Unknown app ' + id));

      if (kbnServer.status.isGreen()) {
        return reply.renderApp(app);
      } else {
        return reply.renderStatusPage();
      }
    }
  });

  async function getPayload(app) {
    return {
      app: app,
      nav: uiExports.navLinks.inOrder,
      version: kbnServer.version,
      buildNum: config.get('pkg.buildNum'),
      buildSha: config.get('pkg.buildSha'),
      basePath: config.get('server.basePath'),
      serverName: config.get('server.name'),
      devMode: config.get('env.dev'),
      uiSettings: {
        defaults: await server.uiSettings().getDefaults(),
        user: {}
      },
      vars: defaults(app.getInjectedVars() || {}, uiExports.defaultInjectedVars),
    };
  }

  function viewAppWithPayload(app, payload) {
    return this.view(app.templateName, {
      app: app,
      kibanaPayload: payload,
      bundlePath: `${config.get('server.basePath')}/bundles`,
    });
  }

  async function renderApp(app) {
    const isElasticsearchPluginRed = server.plugins.elasticsearch.status.state === 'red';
    const payload = await getPayload(app);
    if (!isElasticsearchPluginRed) {
      payload.uiSettings.user = await server.uiSettings().getUserProvided();
    }
    return viewAppWithPayload.call(this, app, payload);
  }

  async function renderAppWithDefaultConfig(app) {
    const payload = await getPayload(app);
    return viewAppWithPayload.call(this, app, payload);
  }

  server.decorate('reply', 'renderApp', renderApp);
  server.decorate('reply', 'renderAppWithDefaultConfig', renderAppWithDefaultConfig);
};
