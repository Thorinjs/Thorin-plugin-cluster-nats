'use strict';

const initClient = require('./lib/client'),
  initTransport = require('./lib/transport');

/**
 * Cluster plugin for microservice communication and exposing of actions.
 * Uses nats.io server for this.
 */
module.exports = function (thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: pluginName || 'cluster',
    debug: false,
    url: [],      // An array of Nats.io server URLs (see spec in nats.io documentation)
    required: false,  // if set to true, we will not start the thorin app without this
    username: null,
    password: null,
    token: null,
    type: thorin.app,  // the service type
    name: thorin.id,    // the service id
    options: {    // Additional nats.io direct client options. See https://github.com/nats-io/node-nats
      encoding: 'utf8',
      json: true,
      maxReconnectAttempts: -1,
      reconnectWait: 250
    }
  }, opt);
  const logger = thorin.logger(opt.logger);
  if (typeof opt.url === 'string') {
    opt.url = [opt.url];
  }
  if (!(opt.url instanceof Array)) {
    throw thorin.error('CLUSTER.CONFIG', 'URL Configuration must be an array of nats server URLs');
  }
  // Validate URLs as array of "nats://ip:port"]
  for (let i = 0; i < opt.url.length; i++) {
    let u = opt.url[i];
    if (typeof u !== 'string' || !u) {
      throw thorin.error('CLUSTER.CONFIG', 'URL Configuration must be an array of nats server URLs');
    }
    if (u.indexOf('://') === -1) u = 'nats://' + u;
    if (u.lastIndexOf(':') !== 5) {
      u += ':4222';
    }
    opt.url[i] = u;
  }
  if (opt.url.length === 0) {
    throw thorin.error('CLUSTER.CONFIG', 'At least one Nats server URL is required');
  }
  const pluginObj = initClient(thorin, opt, logger);
  initTransport(thorin, opt, pluginObj);
  return pluginObj;
};
module.exports.publicName = 'cluster';