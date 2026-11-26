// The renderer can offer a recorded attachment. Only the main process verifies its bytes.
export function isRecordedPdf(material) {
  return material?.attachmentConfirmed === true &&
    typeof material.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(material.sha256) &&
    typeof material.path === 'string' && /\.pdf$/i.test(material.path)
}
