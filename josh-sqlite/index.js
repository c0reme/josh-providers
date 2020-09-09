const Database = require('better-sqlite3');

// Lodash should probably be a core lib but hey, it's useful!
const {
  get: _get,
  set: _set,
  isNil,
  isArray,
  isFunction,
  flatten,
  cloneDeep,
  unset,
} = require('lodash');

// Native imports
const { resolve, sep } = require('path');
const fs = require('fs');

// Custom error codes with stack support.
const Err = require('./error.js');

const { getPaths, sanitize } = require("./utils.js");

module.exports = class JoshProvider {

  constructor(options) {
    if(options.inMemory) {
      // This is there for testing purposes, really. 
      // But hey, if you want an in-memory database, knock yourself out, kiddo!
      this.db = new Database(':memory:');
      this.name = ':memory:';
    } else {
      if (!options.name) throw new Error('Must provide options.name');
      this.dataDir = resolve(process.cwd(), options.dataDir || 'data');

      if (!options.dataDir) {
        if (!fs.existsSync('./data')) {
          fs.mkdirSync('./data');
        }
      }
  
      this.name = options.name;
      this.validateName();
      this.db = new Database(`${this.dataDir}${sep}josh.sqlite`);
    }

  }

  /**
   * Internal method called on persistent Josh to load data from the underlying database.
   * @param {Map} Josh In order to set data to the Josh, one must be provided.
   * @returns {Promise} Returns the defer promise to await the ready state.
   */
  async init() {
    const table = this.db.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?;").get(this.name);
    if (!table['count(*)']) {
      this.db.prepare(`CREATE TABLE '${this.name}' (key text, path text, value text)`).run();
      this.db.pragma('synchronous = 1');
      if (this.wal) this.db.pragma('journal_mode = wal');
    }
    this.db.prepare(`CREATE TABLE IF NOT EXISTS 'internal::autonum' (josh TEXT PRIMARY KEY, lastnum INTEGER)`).run();
    const row = this.db.prepare("SELECT lastnum FROM 'internal::autonum' WHERE josh = ?").get(this.name);
    if (!row) {
      this.db.prepare("INSERT INTO 'internal::autonum' (josh, lastnum) VALUES (?, ?)").run(this.name, 0);
    }

    this.deleteStmt = this.db.prepare(`DELETE FROM '${this.name}' WHERE key=@key AND path=@path;`);
    this.insertStmt = this.db.prepare(`INSERT INTO '${this.name}' (key, path, value) VALUES (@key, @path, @value);`);

    this.runMany = this.db.transaction((transactions) => {
      for(const [statement, row] of transactions) statement.run(row);
    });
    this.isInitialized = true;
  }

  get(key, path) {
    const query = this.db.prepare(`SELECT * FROM '${this.name}' WHERE key = ?${path ? ' AND path = ?' : " AND path='::NULL::'"};`);
    const row = path ? query.get(key, path) : query.get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  getAll() {
    const stmt = this.db.prepare(`SELECT * from '${this.name}' WHERE path='::NULL::';`);
    return stmt.all().map(row => [row.key, JSON.parse(row.value)]);
  }

  getMany(keys) {
    return this.db.prepare(`SELECT * FROM '${this.name}' WHERE key IN (${'?, '.repeat(keys.length).slice(0, -2)}) AND path='::NULL::';`)
      .all(keys)
      .reduce((acc, row) => {
        acc[row.key] = JSON.parse(row.value);
        return acc;
      }, {});
  }

  random(count = 1) {
    const data = this.db.prepare(`SELECT * FROM '${this.name}' WHERE path='::NULL::' ORDER BY RANDOM() LIMIT ${Number(count)};`).all();
    return count > 1 ? data : data[0];
  }

  randomKey(count = 1) {
    const data = this.db.prepare(`SELECT rowid FROM '${this.name}' WHERE path='::NULL::' ORDER BY RANDOM() LIMIT ${Number(count)};`).all();
    return count > 1 ? data.map(row => row.key) : data[0].key;
  }

  has(key, path) {
    const query = this.db.prepare(`SELECT count(*) FROM '${this.name}' WHERE key = ?${path ? ' AND path = ?' : "AND path='::NULL::'"};`);
    const row = path ? query.get(key, path) : query.get(key);
    return row['count(*)'] === 1;
  }

  /**
   * Retrieves all the indexes (keys) in the database for this Josh, even if they aren't fetched.
   * @return {array<string>} Array of all indexes (keys) in the Josh, cached or not.
   */
  keys() {
    const rows = this.db.prepare(`SELECT key FROM '${this.name}' WHERE path='::NULL::';`).all();
    return rows.map(row => row.key);
  }

  values() {
    const rows = this.db.prepare(`SELECT value FROM '${this.name}' WHERE path='::NULL::';`).all();
    return rows.map(row => this.parseData(row.value));
  }

  /**
   * Retrieves the number of rows in the database for this Josh, even if they aren't fetched.
   * @return {integer} The number of rows in the database.
   */
  count() {
    const data = this.db.prepare(`SELECT count(*) FROM '${this.name}' WHERE path='::NULL::';`).get();
    return data['count(*)'];
  }

  set(key, path, val) {
    key = this.keyCheck(key);
    const executions = this.compareData(key, val, path);
    this.runMany(executions);
    return this;
  }

  delete(key, path) {
    this.check(key, 'Object');
    if(!path || path.length === 0) {
      this.db.prepare(`DELETE FROM '${this.name}' WHERE key = ?`).run(key);
      return this;
    }
    const value = this.get(key);
    unset(value, path);
    this.set(key, null, value);
    return this;
  }

  clear() {
    this.db.exec(`DELETE FROM '${this.name}'`);
    return this;
  }

  push(key, path, value, allowDupes) {
    this.check(key, 'Array', path);
    const data = this.get(key, path);
    if (!allowDupes && data.indexOf(value) > -1) return;
    data.push(value);
    this.set(key, path, data);
    return this;
  }

  remove(key, path, val) {
    this.check(key, 'Array', path);
    const data = this.get(key, path);
    const criteria = isFunction(val) ? val : value => val === value;
    const index = data.findIndex(criteria);
    if (index > -1) {
      data.splice(index, 1);
    }
    this.set(key, path, data);
    return this;
  }

  inc(key, path) {
    this.check(key, ['Number'], path);
    this.set(key, path, this.get(key, path) + 1);
    return this;
  }

  dec(key, path) {
    this.check(key, ['Number'], path);
    this.set(key, path, this.get(key, path) - 1);
    return this;
  }

  async findByFunction(fn, path) {
    const keys = this.keys();
    while (keys.length > 0) {
      const currKey = keys.shift();
      const value = this.get(currKey);
      if (await fn(path ? _get(value, path) : value, currKey)) {
        return [value, currKey];
      }
    }
    return null;
  }

  findByValue(path, value) {
    const query = this.db.prepare(`SELECT key, value FROM '${this.name}' WHERE value = ?${path ? ' AND path = ?' : " AND path = '::NULL::'"} LIMIT 1;`);
    const results = path ? query.get(JSON.stringify(value), path) : query.get(JSON.stringify(value));
    return results ? {[results.key]: this.get(results.key)} : null;
  }

  async filterByFunction(fn, path) {
    const all = this.getAll();
    const returnObject = {};
    for (const [key, value] of all) {
      if (await fn(path ? _get(value, path) : value, key)) {
        returnObject[key] = value;
      }
    }
    return returnObject;
  }

  filterByValue(path, value) {
    const query = this.db.prepare(`SELECT key, value FROM '${this.name}' WHERE value = ?${path ? ' AND path = ?' : " AND path = '::NULL::'"}`);
    const rows = path ? query.all(JSON.stringify(value), path) : query.all(JSON.stringify(value));
    if(rows.length === 0) {
      return [];
    }
    return rows.reduce((acc, row) => {
      acc[row.key] = this.get(row.key);
      return acc;
    }, {})
  }

  close() {
    return this.db.close();
  }

  autoId() {
    let { lastnum } = this.db.prepare("SELECT lastnum FROM 'internal::autonum' WHERE josh = ?").get(this.name);
    lastnum++;
    this.db.prepare("INSERT OR REPLACE INTO 'internal::autonum' (josh, lastnum) VALUES (?, ?)").run(this.name, lastnum);
    return lastnum.toString();
  }

  keyCheck(key) {
    if (isNil(key) || !['String', 'Number'].includes(key.constructor.name)) {
      throw new Error('josh-sqlite require keys to be strings or numbers.');
    }
    return key.toString();
  }

  /**
   * Internal method used to validate filename/tablename (valid Windows filenames)
   * @private
   */
  validateName() {
    // Do not delete this internal method.
    this.name = this.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  }

  parseData(data) {
    try {
      return JSON.parse(data);
    } catch (err) {
      console.log('Error parsing data : ', err);
      return null;
    }
  }

  /*
   * INTERNAL method to verify the type of a key or property
   * Will THROW AN ERROR on wrong type, to simplify code.
   * @param {string|number} key Required. The key of the element to check
   * @param {string} type Required. The javascript constructor to check
   * @param {string} path Optional. The dotProp path to the property in JOSH.
   */
  // Herefore I indicate that I do understand part of this would be easily resolved with TypeScript but I don't do TS... yet.
  // TODO: OPTIMIZE FOR LESS QUERIES. A LOT less queries. wow this is bad.
  check(key, type, path = null) {
    if (!this.has(key)) throw new Err(`The key "${key}" does not exist in JOSH "${this.name}"`, 'JoshPathError');
    if (!type) return;
    if (!isArray(type)) type = [type];
    if (!isNil(path)) {
      this.check(key, 'Object');
      const data = this.get(key);
      if (isNil(_get(data, path))) {
        throw new Err(`The property "${path}" in key "${key}" does not exist. Please set() it or ensure() it."`, 'JoshPathError');
      }
      if (!type.includes(_get(data, path).constructor.name)) {
        throw new Err(`The property "${path}" in key "${key}" is not of type "${type.join('" or "')}" in JOSH "${this.name}" 
(key was of type "${_get(data, path).constructor.name}")`, 'JoshTypeError');
      }
    } else if (!type.includes(this.get(key)).constructor.name) {
      throw new Err(`The key "${key}" is not of type "${type.join('" or "')}" in JOSH "${this.name}" (key was of type "${this.get(key).constructor.name}")`, 'JoshTypeError');
    }
  }

  // TODO: Check if I can figure out how to get actual NULL values instead of ::NULL::.
  compareData (key, newValue, path) {
    const executions = [];
    const currentData = this.has(key) ? this.get(key) : '::NULL::';
    const currentPaths = getPaths(currentData);
    const paths = path ? getPaths(_set(cloneDeep(currentData), path, newValue)) : getPaths(newValue);

    for(const [path, value] of Object.entries(currentPaths)) {
      if(isNil(paths[path]) || paths[path] !== value) {
        executions.push([this.deleteStmt, { key, path }]);
        if(!isNil(paths[path])) executions.push([this.insertStmt, { key, path, value: paths[path] }])
      }
      delete paths[path];
    }
    for(const [path, value] of Object.entries(paths)) {
      executions.push([this.insertStmt, { key, path, value }])
    }
    return executions;
  }

  // TODO: Figure out how to make this similar to GET, 
  setMany(data, overwrite) {
    if (isNil(data) || data.constructor.name !== 'Array') {
      throw new Error('Provided data was not an array of [key, value] pairs.');
    }
    const existingKeys = this.keys();

    this.runMany(flatten(data
      .filter(([key]) => overwrite || !existingKeys.includes(key))
      .map(([key, value]) => this.compareData(key, value))));
    return this;
  }

};
