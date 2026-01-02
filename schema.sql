-- Table untuk menyimpan data wajah
CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    vector TEXT NOT NULL, -- JSON array of floats
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table untuk logs akses
CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    face_id INTEGER,
    name TEXT,
    confidence REAL,
    action TEXT, -- 'recognize', 'enroll', 'delete'
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (face_id) REFERENCES faces(id)
);

-- Index untuk performa
CREATE INDEX IF NOT EXISTS idx_faces_name ON faces(name);
CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp);