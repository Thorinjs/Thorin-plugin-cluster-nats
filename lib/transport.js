'use strict';
/**
 * The transport service registers all actions as requestable by clients.
 */
module.exports = (thorin, opt, pluginObj) => {

  const logger = thorin.logger(opt.logger),
    actions = Symbol(),
    disabled = Symbol(),
    subs = Symbol(),
    pending = Symbol();
  let requestId = 1;

  class ClusterTransport extends thorin.Interface.Transport {
    static publicName() {
      return "cluster"
    }

    constructor() {
      super();
      this.name = 'cluster';
      this.type = 2;
      this[actions] = {}; // array of actions to bind.
      this[subs] = {};
      this[pending] = [];
      this.binded = false;
      thorin.on(thorin.EVENT.RUN, () => {
        let items = this[pending];
        this[pending] = null;
        for (let i = 0, len = items.length; i < len; i++) {
          this.expose(items[i]);
        }
      });
    }

    routeAction(actionObj) {
      if (this[pending] === null) {  // already exposing
        return this.expose(actionObj);
      }
      this[pending].push(actionObj);
      return true;
    }

    /**
     * Handles the incoming request
     * */
    handleIncomingRequest(actionObj, req, replyTo) {
      let nc = pluginObj.nc;
      try {
        req = JSON.parse(req);
        if (typeof req !== 'object' || !req) return;
      } catch (e) {
        logger.debug(`Received invalid payload for action: ${actionObj.name} [${req}]`);
        return;
      }
      if (typeof replyTo === 'undefined') {
        logger.debug(`Received no replyer for action: ${actionObj.name}`);
        return;
      }
      let service = req.s || {},
        payload = req.p || {};
      let actionId = requestId++;
      if (actionObj.hasDebug !== false && opt.debug && opt.debug.request && thorin.env !== 'production') {
        logger.trace(`[START ${actionId}] - ${actionObj.name}`);
      }
      const intentObj = new thorin.Intent(actionObj.name, payload, (wasError, result) => {
        let took = intentObj.took,
          err, isCustomErr = false;
        if (wasError) {
          err = (typeof result === 'object' && result.error ? result.error : result);
          if (err instanceof Error && err.name.indexOf('Thorin') === 0) {
            err = result.error;
          } else {
            err = thorin.error(result.error || result);
          }
          if (err && err.source) isCustomErr = true;
        }
        if (actionObj.hasDebug !== false && opt.debug) {
          if (wasError) {
            let msg = `[ENDED ${actionId} - ${result.type} [${err.code}]`;
            if (typeof err.statusCode !== 'undefined') {
              msg += ` - ${err.statusCode}`;
            }
            msg += ` (${took}ms)`;
            logger[err.statusCode < 500 ? 'trace' : 'warn'](msg);
            if (isCustomErr) {
              logger.trace(err.source.stack);
            }
          } else {
            logger.debug(`[ENDED ${actionId}] - ${result.type} (${took}ms)`)
          }
        }
        if (wasError) {
          return nc.publish(replyTo, {
            e: true,
            d: result
          });
        }
        nc.publish(replyTo, {
          e: false,
          d: result
        });
      });
      if (typeof req.c === 'object' && req.c) {
        intentObj.client(req.c);
      }
      intentObj._setAuthorization('CLUSTER', 'AUTHENTICATED');
      intentObj.transport = 'cluster';
      thorin.dispatcher.triggerIntent(intentObj);
    }

    /**
     * Binds a callback function to whenever this action
     * */
    expose(actionObj) {
      let nc = pluginObj.nc;
      if (!nc) {
        return false;
      }
      if (this[actions][actionObj.name]) {
        console.warn(`Action ${actionObj.name} already exposed to Nats`);
        return false;
      }
      this[actions][actionObj.name] = actionObj;
      let subject = `${opt.type}#${actionObj.name}`;
      let subId = nc.subscribe(subject, this.handleIncomingRequest.bind(this, actionObj));
      this[subs][actionObj.name] = subId;
    }


    disableAction(actionName) {
      if (this[disabled][actionName]) return;
      this[disabled][actionName] = true;
      if (typeof this[actions][actionName] === 'undefined') return false;
      if (typeof this[subs][actionName] === 'undefined') return false;
      let nc = pluginObj.nc;
      if (!nc) {
        logger.warn(`Nats plugin not ready yet`);
        return false;
      }
      nc.unsubscribe(this[subs][actionName]);
      delete this[subs][actionName];
    }

    enableAction(actionName) {
      if (!this[disabled][actionName]) return;
      delete this[disabled][actionName];
      if (!this[actions][actionName]) return;
      return this.expose(this[actions][actionName]);
    }
  }

  let transportObj = new ClusterTransport();
  thorin.dispatcher.registerTransport(transportObj);
};