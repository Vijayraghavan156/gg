'use strict';

class TprmError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'TprmError';
    this.status = status;
    Object.assign(this, details);
  }
}

module.exports = { TprmError };
