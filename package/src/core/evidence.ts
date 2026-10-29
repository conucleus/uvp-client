/**
 * Runtime-agnostic evidence hashing surface: single source is
 * @uvp-eth/canonical-json. File-based hashing is Node-only and lives in the
 * /server entry so /core never aggregates node:fs.
 */
export {
  canonicalJson,
  hashEvidenceBytes,
  hashEvidenceJson,
  hashEvidenceText,
} from '@uvp-eth/canonical-json';
