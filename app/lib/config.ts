export const rcloneConfig = {
  remote: process.env.RCLONE_REMOTE || "remote",
  bucket: process.env.RCLONE_BUCKET || "khld-audiobooks",
  
  get fsPath() {
    return `${this.remote}:${this.bucket}`;
  },
  
  get fsPathWithSlash() {
    return `${this.remote}:${this.bucket}:`;
  },
  
  get fsPathForList() {
    return `${this.remote}:${this.bucket}`;
  },
};
