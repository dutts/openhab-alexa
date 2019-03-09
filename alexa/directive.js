/**
 * Copyright (c) 2014-2019 by the respective copyright holders.
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 */

/**
 * Amazon Smart Home Skill Directive for API V3
 */
const camelcase = require('camelcase');
const { sprintf } = require('sprintf-js');
const log = require('@lib/log.js');
const rest = require('@lib/rest.js');
const AlexaPropertyMap = require('./propertyMap.js');
const AlexaResponse = require('./response.js');

/**
 * Defines Alexa directive class
 * @extends AlexaResponse
 */
class AlexaDirective extends AlexaResponse {
  /**
   * Constructor
   * @param {Object}   directive
   * @param {Function} callback
   */
  constructor(directive, callback) {
    super(directive, callback);
    this.directive = directive;
    this.propertyMap = new AlexaPropertyMap();

    // if we have a JSON cookie, parse it and set on endpoint
    if (directive.endpoint && directive.endpoint.cookie && directive.endpoint.cookie.propertyMap) {
      this.propertyMap.load(directive.endpoint.cookie.propertyMap);
    }
  }

  /**
   * Executes directive based on its header camelcase name and map property
   */
  execute() {
    // Convert directive name to camelcase format
    //  e.g. AdjustBrightness => adjustBrightness
    const name = camelcase(this.directive.header.name);
    // Determine directive method name using map property if defined, fallback to directive camelcase name
    const method = this.map && this.map[name] || name;

    // Execute directive method if defined, otherwise return error
    if (typeof this[method] === 'function') {
      this[method]();
    } else {
      log.error('Unsupported directive:', {
        namespace: this.directive.header.namespace,
        name: this.directive.header.name
      });
      this.returnAlexaErrorResponse({
        payload: {
          type: 'INVALID_DIRECTIVE',
          message: 'Unsupported directive'
        }
      });
    }
  }

  /**
   * Generic method to post list of items to OH
   *  and then return a formatted response to the Alexa request
   *
   *
   * @param {Array}  items
   * @param {Object} parameters     Additional parameters [header, payload, response] (optional)
   */
  postItemsAndReturn(items, parameters = {}) {
    const promises = [];
    items.forEach((item) => {
      promises.push(rest.postItemCommand(this.directive.endpoint.scope.token, item.name, item.state));
    });
    Promise.all(promises).then(() => {
      if (parameters.response) {
        log.debug('postItemsAndReturn done with response:', parameters.response);
        this.returnAlexaResponse(parameters.response);
      } else {
        this.getPropertiesResponseAndReturn(parameters);
      }
    }).catch((error) => {
      log.error('postItemsAndReturn failed with error:', error);
      if (error.statusCode === 404) {
        this.returnAlexaErrorResponse({
          payload: {
            type: 'NO_SUCH_ENDPOINT',
            message: 'Endpoint not found'
          }
        });
      } else {
        this.returnAlexaGenericErrorResponse();
      }
    });
  }

  /**
   * Generic method to generate properties response
   *  based of interface-specific properties latest item state from OH
   *  and then return a formatted response to the Alexa request
   *
   * @param {Object} parameters     Additional parameters [header, payload, response] (optional)
   */
  getPropertiesResponseAndReturn(parameters = {}) {
    // Use the property map defined interface names if this.interface not defined (e.g. reportState)
    const interfaceNames = this.interface ? [this.interface] : Object.keys(this.propertyMap);
    // Get list of all unique item objects part of interfaces
    const interfaceItems = this.propertyMap.getItemsByInterfaces(interfaceNames);
    const promises = [];

    interfaceItems.forEach((item) => {
      promises.push(this.getItemState(item).then((result) => {
        // Update item information in propertyMap object for each item capabilities
        item.capabilities.forEach((capability) => {
          this.propertyMap[capability.interface][capability.property].item = result;
        });
        return result;
      }));
    });
    Promise.all(promises).then((items) => {
      // Throw error if one of the state item is set to 'NULL'
      if (items.find(item => item.state === 'NULL')) {
        throw {reason: 'Invalid item state returned by openHAB', items: items};
      }
      // Get context properties response and throw error if one of its value not defined
      const properties = this.propertyMap.getContextPropertiesResponse(interfaceNames);
      if (properties.find(property => typeof property.value === 'undefined')) {
        throw {reason: 'Undefined context property value', properties: properties};
      }
      // Generate properties response
      const response = this.generateResponse(Object.assign(parameters, {
        context: {
          properties: properties
        }
      }));
      log.debug('getPropertiesResponseAndReturn done with response:', response);
      this.returnAlexaResponse(response);
    }).catch((error) => {
      log.error('getPropertiesResponseAndReturn failed with error:', error);
      if (error.statusCode === 404) {
        this.returnAlexaErrorResponse({
          payload: {
            type: 'NO_SUCH_ENDPOINT',
            message: 'Endpoint not found'
          }
        });
      } else {
        this.returnAlexaGenericErrorResponse();
      }
    });
  }

  /**
   * Returns item state from OH using item sensor name, if defined, over standard one
   * @param  {Object}  item
   * @return {Promise}
   */
  getItemState(item) {
    const itemName = item.sensor || item.name;
    return rest.getItem(this.directive.endpoint.scope.token, itemName).then((result) =>
      Object.assign(result, {state: formatItemState(result)}));
  }
}

/**
 * Defines OH state description formatter pattern
 * @type {RegExp}
 */
const ITEM_STATE_FORMATTER_PATTERN = /%(?:[.0]\d+)?[dfs]/;

/**
 * Returns OH item state formatted based on its state description pattern
 *
 * @param  {Object} item
 * @return {String}
 */
function formatItemState(item) {
  const format = item.stateDescription && item.stateDescription.pattern &&
    item.stateDescription.pattern.match(ITEM_STATE_FORMATTER_PATTERN);
  const state = item.state;
  const type = item.type.split(':').shift();

  if (format && state != 'NULL') {
    switch (type) {
      case 'Dimmer':
      case 'Number':
      case 'Rollershutter':
        return sprintf(format[0], parseFloat(state));
      case 'String':
        return sprintf(format[0], state);
    }
  }
  return state;
}

module.exports = AlexaDirective;
