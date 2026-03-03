const { Pool } = require('pg');

class ConfigManager {
  constructor(pool) {
    this.pool = pool;
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  /**
   * Get a configuration value.
   * Checks cache first, then DB.
   * @param {string} key - The configuration key
   * @param {any} defaultValue - Default value if key not found
   * @returns {Promise<any>}
   */
  async get(key, defaultValue = null) {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp < this.cacheTTL)) {
      return cached.value;
    }

    try {
      const result = await this.pool.query(
        'SELECT value, value_type FROM app_settings WHERE key = $1',
        [key]
      );

      if (result.rows.length === 0) {
        return defaultValue;
      }

      const { value, value_type } = result.rows[0];
      const parsedValue = this.parseValue(value, value_type);

      this.cache.set(key, {
        value: parsedValue,
        timestamp: now
      });

      return parsedValue;
    } catch (err) {
      console.error(`ConfigManager: Error fetching key ${key}`, err);
      return defaultValue;
    }
  }

  /**
   * Update a configuration value.
   * Validates value, updates DB, logs change, and invalidates cache.
   * @param {string} key - The configuration key
   * @param {any} newValue - The new value
   * @param {string} changedBy - User/System identifier
   * @returns {Promise<object>} - Result object { success: true, message: '...' }
   */
  async update(key, newValue, changedBy = 'system') {
    try {
      // 1. Fetch metadata for validation
      const metaRes = await this.pool.query(
        'SELECT value, value_type, min_value, max_value FROM app_settings WHERE key = $1',
        [key]
      );

      if (metaRes.rows.length === 0) {
        throw new Error(`Setting key '${key}' not found.`);
      }

      const { value: oldValueStr, value_type, min_value, max_value } = metaRes.rows[0];
      const oldValue = this.parseValue(oldValueStr, value_type);

      // 2. Validate type and range
      let validatedValue = newValue;
      if (value_type === 'int') {
        validatedValue = parseInt(newValue, 10);
        if (isNaN(validatedValue)) throw new Error(`Value must be an integer.`);
      } else if (value_type === 'float') {
        validatedValue = parseFloat(newValue);
        if (isNaN(validatedValue)) throw new Error(`Value must be a number.`);
      } else if (value_type === 'boolean') {
        validatedValue = String(newValue).toLowerCase() === 'true';
      }

      if (min_value !== null && validatedValue < parseFloat(min_value)) {
        throw new Error(`Value must be >= ${min_value}`);
      }
      if (max_value !== null && validatedValue > parseFloat(max_value)) {
        throw new Error(`Value must be <= ${max_value}`);
      }

      // 3. Update DB
      await this.pool.query('BEGIN');

      await this.pool.query(
        'UPDATE app_settings SET value = $1, updated_at = now() WHERE key = $2',
        [String(validatedValue), key]
      );

      // 4. Log change
      await this.pool.query(
        `INSERT INTO settings_change_log (key, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [key, String(oldValue), String(validatedValue), changedBy]
      );

      await this.pool.query('COMMIT');

      // 5. Update Cache immediately
      this.cache.set(key, {
        value: validatedValue,
        timestamp: Date.now()
      });

      return { success: true, message: 'Setting updated successfully.' };

    } catch (err) {
      await this.pool.query('ROLLBACK');
      console.error(`ConfigManager: Update failed for ${key}`, err);
      throw err;
    }
  }

  /**
   * Helper to parse string values based on type
   */
  parseValue(value, type) {
    if (type === 'int') return parseInt(value, 10);
    if (type === 'float') return parseFloat(value);
    if (type === 'boolean') return value.toLowerCase() === 'true';
    return value;
  }
  
  /**
   * Get all settings metadata (for UI)
   */
  async getAllSettings() {
      try {
          const result = await this.pool.query(
              'SELECT key, value, description, value_type, min_value, max_value, updated_at FROM app_settings ORDER BY key'
          );
          return result.rows.map(row => ({
              ...row,
              value: this.parseValue(row.value, row.value_type)
          }));
      } catch (err) {
          console.error('ConfigManager: Failed to get all settings', err);
          return [];
      }
  }
}

module.exports = ConfigManager;
