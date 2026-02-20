/**
 * Lightweight Trend Forecasting Logic (Phase 8)
 * 
 * Uses simple linear regression over a moving window to estimate trend
 * and predicts future values based on current level + trend.
 */

class Forecaster {
    constructor(historyLimit = 60) {
        this.history = []; // Array of { timestamp, value }
        this.limit = historyLimit;
    }

    /**
     * Add new data point and maintain history limit
     */
    addDataPoint(timestamp, value) {
        this.history.push({ timestamp, value });
        if (this.history.length > this.limit) {
            this.history.shift();
        }
    }

    /**
     * Calculate linear regression: y = mx + b
     * returns { m (slope), b (intercept), confidence (r-squared) }
     */
    _calculateTrend() {
        if (this.history.length < 5) return { m: 0, b: this.history[this.history.length - 1]?.value || 0, r2: 0 };

        const n = this.history.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

        // Use index as X to simplify timestamp scale
        for (let i = 0; i < n; i++) {
            const y = this.history[i].value;
            sumX += i;
            sumY += y;
            sumXY += i * y;
            sumX2 += i * i;
            sumY2 += y * y;
        }

        const denominator = (n * sumX2 - sumX * sumX);
        if (denominator === 0) return { m: 0, b: sumY / n, r2: 0 };

        const m = (n * sumXY - sumX * sumY) / denominator;
        const b = (sumY - m * sumX) / n;

        // Correlation coefficient (r)
        const rNum = (n * sumXY - sumX * sumY);
        const rDen = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
        const r2 = rDen !== 0 ? Math.pow(rNum / rDen, 2) : 0;

        return { m, b, r2 };
    }

    /**
     * Predict value X steps ahead
     * @param {number} stepsAhead - number of intervals (e.g. 10 intervals of 30s = 5 mins)
     */
    predict(stepsAhead = 10) {
        if (this.history.length < 2) return { predicted: 0, confidence: 0 };

        const { m, b, r2 } = this._calculateTrend();
        const currentIndex = this.history.length - 1;
        const targetIndex = currentIndex + stepsAhead;

        // Prediction = b + m * targetIndex
        let predicted = b + m * targetIndex;

        // Ensure no negative traffic
        predicted = Math.max(0, predicted);

        return {
            predicted: parseFloat(predicted.toFixed(2)),
            confidence: parseFloat(r2.toFixed(2)),
            trend: m > 0 ? 'increasing' : (m < 0 ? 'decreasing' : 'stable')
        };
    }

    /**
     * Compare previous prediction with current actual
     */
    calculateError(actual, predicted) {
        if (!predicted || predicted === 0) return 0;
        return Math.abs((actual - predicted) / predicted) * 100;
    }
}

module.exports = Forecaster;
