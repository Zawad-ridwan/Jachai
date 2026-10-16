/**
 * An analysis failure with a code the extension knows how to explain.
 * Any status of 400 or above makes the quota meter refund the tokens, so
 * people are only ever charged for analyses that succeed.
 */
export class AnalysisError extends Error {
  constructor(code, status = 502, detail = null) {
    super(code);
    this.name = 'AnalysisError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}