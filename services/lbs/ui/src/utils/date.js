/**
 * Centralized Date and Timezone Utilities
 */

/**
 * Returns the IANA timezone name of the current environment.
 * @returns {string} e.g., "America/New_York", "Asia/Tokyo"
 */
export function getTimezoneName() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (e) {
        return "UTC";
    }
}

/**
 * Returns the date in YYYY-MM-DD format based on the local timezone.
 * Unlike new Date().toISOString().split('T')[0] which returns the UTC date,
 * this function preserves the local day.
 * 
 * @param {Date} [date=new Date()] 
 * @returns {string} YYYY-MM-DD
 */
export function getLocalISODateString(date = new Date()) {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().split('T')[0];
}

/**
 * Creates custom headers for API requests, including timezone.
 * @param {object} baseHeaders - Existing headers
 * @returns {object} Headers with X-Timezone added
 */
export function getApiHeaders(baseHeaders = {}) {
    return {
        ...baseHeaders,
        'X-Timezone': getTimezoneName()
    };
}
