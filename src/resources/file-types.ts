/**
 * Content type and artifact type for a file name, as the Python SDK and the web
 * app assign them (`beakr_sdk/resources/_upload.py`, beakr-web's
 * `lib/utils/artifact-file-type.ts`), so a TypeScript upload lands as the same
 * kind of file.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/x-wav",
  ".m4a": "audio/mp4",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ipynb": "application/x-ipynb+json",
};

/** Extensions the web classifies as scientific data (browsers report them as octet-stream). */
const SCIENTIFIC_EXTENSIONS = new Set(
  (
    ".h5ad .loom .fasta .fa .fastq .bam .sam .vcf .bed .gff .gtf .bigwig .bw .gct .gctx " +
    ".h5 .hdf5 .hdf .sdf .mol .mol2 .smi .pdb .cif .nii .nifty .dcm .edf .nc .nc4 " +
    ".parquet .feather .mtx .pzfx .pzm .pzt .prism .dna"
  ).split(" "),
);

function extension(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The content type for a file name; `application/octet-stream` when unknown. */
export function guessMimeType(name: string): string {
  return MIME_BY_EXTENSION[extension(name)] ?? "application/octet-stream";
}

/** The artifact type the web app would assign (`detectArtifactType`). */
export function detectArtifactType(mimeType: string, name: string): string {
  const suffix = extension(name);
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "doc";
  if (mimeType.includes("spreadsheet") || mimeType === "text/csv") return "dataset";
  if (mimeType === "application/json") return "json";
  if (
    mimeType === "application/x-ipynb+json" ||
    mimeType === "text/x-rmarkdown" ||
    suffix === ".ipynb" ||
    suffix === ".rmd"
  ) {
    return "notebook";
  }
  if (SCIENTIFIC_EXTENSIONS.has(suffix)) return "scientific_data";
  return "doc";
}
