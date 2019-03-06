'use strict';
const nats = require('nats'),
  EventEmitter = require('events').EventEmitter;

const proxyMiddleware = require('./middleware/proxy'),
  proxyChain = require('./middleware/chain'),
  initAction = require('./clusterAction');

/**
 * This is a client interface of the Nast plugin
 * Emits:
 *  - connect
 *  - disconnect
 * */
module.exports = (thorin, opt, logger) => {
  const config = Symbol('config');

  class NatsClient extends EventEmitter {

    /**
     * Instantiates the server connection.
     * */
    constructor(opt) {
      super();
      this.nc = null;
      this.connected = false;
      this[config] = opt;
    }

    /**
     * Returns the nats server instance
     * */
    getClient() {
      return this.nc;
    }

    /**
     * On thorin run, try to connect to nats.
     * */
    async run(done) {
      try {
        await this.connect(this[config]);
      } catch (e) {
        logger.warn(`Could not connect to Nats.io server`);
        if (this[config].required) return done(e);
      }
      done();
    }


    /**
     * Connect to the Nats server in the options.
     * */
    connect(opt) {
      let cOpt = thorin.util.extend({}, opt.options);
      cOpt.servers = opt.url;
      if (opt.username) cOpt.user = opt.username;
      if (opt.password) cOpt.pass = opt.password;
      if (opt.token) cOpt.token = opt.token;

      return new Promise((resolve, reject) => {
        let nc = this.nc = nats.connect(cOpt);
        this.connected = false;
        nc.once('connect', () => {
          if (opt.debug) logger.trace(`NATS Client connected to server`);
          this.connected = true;
          this.emit('connect');
          resolve(nc);
          nc.on('disconnect', () => {
            if (this.connected) {
              this.emit('disconnect');
              logger.debug(`NATS Client disconnected from server`);
            }
            this.connected = false;
          });
          nc.on('reconnect', () => {
            this.connected = true;
            this.emit('connect');
            if (opt.debug) logger.trace(`NATS Client reconnected to server`);
          });
        });
        nc.once('error', (e) => {
          if (this.connected) {
            logger.warn(`NATS Client encountered an error`);
            logger.debug(e);
            this.emit('disconnect');
          } else {
            logger.warn(`Could not connect to NATS server`);
            reject(e);
          }
        });
      });
    }

    /**
     * Tries to perform a dispatch to a microservice, using nat's requestOne function.
     * @Arguments
     *  - service - the service name
     *  - action - the action name to call
     *  - payload - the payload to send
     *  - opt - (optional) the options
     *  - opt.timeout - specific timeout to use.
     *  - opt.client - the intentObj.client() data
     *  - opt.requierd - if set to false, do not reject the promise if failed.
     *  Note:
     *    if opt is an intentObj, we will use its client() to sendout.
     * */
    async dispatch(service, action, payload = {}, _opt = {}) {
      if (typeof service !== 'string' || !service) throw thorin.error('CLUSTER.DATA', 'Please provide the service name');
      if (typeof action !== 'string' || !action) throw thorin.error('CLUSTER.DATA', 'Please provide the action name');
      if (!this.connected) throw thorin.error('CLUSTER.SERVER', 'A connection to the Nats server is not active');
      const subject = `${service}#${action}`;
      let timeout = this[config].timeout;
      if (typeof _opt.timeout === 'number') timeout = _opt.timeout;
      return new Promise((resolve, reject) => {
        let data = {
          s: {
            t: opt.type,
            n: opt.name
          },
          p: payload || {},
          c: {}
        };
        if (_opt instanceof thorin.Intent) {
          data.c = _opt.client();
        } else if (typeof _opt.client === 'object' && _opt.client) {
          data.c = _opt.client;
        }
        this.nc.requestOne(subject, JSON.stringify(data), {}, timeout, (res) => {
          if (res instanceof nats.NatsError) {
            if (_opt.required === false) return resolve({});
            if (res.code === nats.REQ_TIMEOUT) {
              return reject(thorin.error('CLUSTER.TIMEOUT', res.message, 502));
            }
            return reject(thorin.error('CLUSTER.ERROR', res.message || 'An error occurred while delivering payload', 500, res));
          }
          if (typeof res !== 'object' || !res) {
            if (_opt.required === false) return resolve({});
            return reject(thorin.error('CLUSTER.DATA', 'A valid response was not produced'));
          }
          if (res.e) {
            if (_opt.required === false) return resolve({});
            let err = res.d || {};
            err = err.error || err;
            let terr = thorin.error(err.code || 'CLUSTER.ERROR', err.message || 'An unexpected error occurred');
            if (err.data) terr.data = err.data;
            if (terr.statusCode) err.statusCode = terr.statusCode;
            return reject(terr);
          }
          resolve(res.d);
        });
      });
    }

    /**
     * Simple publisher
     * @Arguments
     *  - topic - the topic
     *  - payload - the data
     * */
    async publish(topic, payload = {}) {
      if (!this.connected) throw thorin.error('CLUSTER.SERVER', 'A connection to the Nats server is not active');
      if (typeof topic !== 'string' || !topic) throw thorin.error('CLUSTER.DATA', 'Please provide a valid topic name');
      return new Promise((resolve, reject) => {
        this.nc.publish(topic, JSON.stringify(payload), (err) => {
          if (err) return reject(thorin.error('CLUSTER.ERROR', err.message || 'An error occurred while publishing data', err));
          resolve();
        });
      });
    }

    /**
     * Simple subscriber
     * @Arguments
     *  - topic - the topic
     *  - fn - the callback function to use when messages come in.
     *  Returns:
     *    subscribeObj.ubsubscribe() - subcription object that can unsubscribe itself.
     * */
    async subscribe(topic, fn) {
      if (!this.connected) throw thorin.error('CLUSTER.SERVER', 'A connection to the Nats server is not active');
      if (typeof topic !== 'string' || !topic) throw thorin.error('CLUSTER.DATA', 'Please provide a valid topic name');
      if (typeof fn !== 'function') throw thorin.error('CLUSTER.DATA', 'A valid callback function is required');
      return new Promise((resolve) => {
        let sid = this.nc.subscribe(topic, fn);
        let subObj = {
          id: sid,
          unsubscribe: () => {
            this.nc.unsubscribe(sid);
          }
        };
        resolve(subObj);
      });
    }

  }

  let pluginObj = new NatsClient(opt);

  proxyMiddleware(thorin, opt, pluginObj);
  proxyChain(thorin, opt, pluginObj);
  initAction(thorin, opt, pluginObj);
  return pluginObj;
}

