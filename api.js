'use strict';

// App API at /api/app/dev.schweiger.dashboard/…
// A new browser can only request a code and collect an approved opaque dashboard connection. Public workspace
// requests validate that connection and a constrained route allowlist; automatic owner credentials never leave
// the app. Existing manual-key routes remain supported. Administrative routes, including automatic connect, need
// the signed-in Homey settings view and are never available through the dashboard broker.
module.exports = {
  async connectWorkspace({ homey, body }) {
    return homey.app.connectWorkspace(body ?? {});
  },

  async requestWorkspace({ homey, body }) {
    return homey.app.requestWorkspace(body ?? {});
  },

  async workspaceEvents({ homey, body }) {
    return homey.app.workspaceEvents(body ?? {});
  },

  async requestPairing({ homey, body }) {
    return homey.app.requestPairing(body ?? {});
  },

  async getPairing({ homey, params }) {
    return homey.app.getPairing(params.id);
  },

  async listPairings({ homey }) {
    return homey.app.listPairings();
  },

  async approvePairing({ homey, params, body }) {
    return homey.app.approvePairing(params.id, body ?? {});
  },

  async declinePairing({ homey, params }) {
    return homey.app.declinePairing(params.id);
  },

  async getApiKeyStatus({ homey }) {
    return homey.app.getApiKeyStatus();
  },

  async setApiKey({ homey, body }) {
    return homey.app.setApiKey(body?.key, { onlyIfUnset: body?.onlyIfUnset === true });
  },

  async listScreens({ homey }) {
    return homey.app.listScreens();
  },

  async renameScreen({ homey, params, body }) {
    return homey.app.renameScreen(params.id, body ?? {});
  },

  async forgetScreen({ homey, params }) {
    return homey.app.forgetScreen(params.id);
  },

  async screenHello({ homey, body }) {
    return homey.app.screenHello(body ?? {});
  },

  async getHighlight({ homey, query }) {
    return homey.app.getHighlight(query?.screen);
  },

  async closeHighlight({ homey, body }) {
    return homey.app.closeHighlightFromScreen(body ?? {});
  },

  async getWidgetModes({ homey }) {
    return homey.app.widgetModes();
  },

  async setWidgetMode({ homey, params, body }) {
    return homey.app.setWidgetMode(params.id, body ?? {});
  },

  async getWidgetSizes({ homey }) {
    return homey.app.widgetSizes();
  },

  async setWidgetSize({ homey, params, body }) {
    return homey.app.setWidgetSize(params.id, body ?? {});
  },
};
