export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    // Handle preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Auth middleware
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ 
        error: 'Unauthorized',
        message: 'Invalid API key'
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Routing
    try {
      switch (path) {
        case '/':
          return handleRoot();
        
        case '/api/faces':
          if (method === 'GET') return await getFaces(env);
          if (method === 'POST') return await enrollFace(request, env);
          break;
        
        case '/api/faces/search':
          if (method === 'POST') return await searchFace(request, env);
          break;
        
        case '/api/faces/recognize':
          if (method === 'POST') return await recognizeFace(request, env);
          break;
        
        case '/api/faces/batch':
          if (method === 'POST') return await batchEnroll(request, env);
          break;
        
        case '/api/faces/export':
          if (method === 'GET') return await exportFaces(env);
          break;
        
        case '/api/faces/clear':
          if (method === 'DELETE') return await clearFaces(env);
          break;
        
        case '/api/led':
          if (method === 'POST') return await controlLED(request);
          break;
        
        case '/api/stats':
          if (method === 'GET') return await getStats(env);
          break;
        
        case '/api/logs':
          if (method === 'GET') return await getLogs(request, env);
          break;
        
        default:
          return notFound();
      }
    } catch (error) {
      console.error('Error:', error);
      return serverError(error);
    }

    return methodNotAllowed();
  }
};

// ===== Helper Functions =====
function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) {
    return 0;
  }
  
  let dot = 0, norm1 = 0, norm2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  return denominator > 0 ? dot / denominator : 0;
}

async function logAction(env, data) {
  try {
    await env.DB.prepare(`
      INSERT INTO access_logs (face_id, name, confidence, action)
      VALUES (?, ?, ?, ?)
    `).bind(
      data.face_id || null,
      data.name || null,
      data.confidence || null,
      data.action
    ).run();
    
    // Limit logs to 1000 entries (cleanup old logs)
    await env.DB.prepare(`
      DELETE FROM access_logs 
      WHERE id NOT IN (
        SELECT id FROM access_logs 
        ORDER BY timestamp DESC 
        LIMIT 1000
      )
    `).run();
    
  } catch (error) {
    console.error('Logging error:', error);
  }
}

// ===== Response Helpers =====
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    }
  });
}

function handleRoot() {
  return jsonResponse({
    name: 'Face Recognition API',
    version: '1.0.0',
    description: 'Cloudflare Worker + D1 Database for Face Recognition',
    endpoints: [
      'GET    /                     - API Documentation',
      'GET    /api/faces            - Get all faces',
      'POST   /api/faces            - Enroll new face',
      'POST   /api/faces/search     - Search face by vector',
      'POST   /api/faces/recognize  - Recognize face (with trigger)',
      'POST   /api/faces/batch      - Batch enroll faces',
      'GET    /api/faces/export     - Export all faces as JSON',
      'DELETE /api/faces/clear      - Clear all faces and logs',
      'POST   /api/led              - Control LED (legacy)',
      'GET    /api/stats            - Get system statistics',
      'GET    /api/logs             - Get access logs'
    ]
  });
}

function notFound() {
  return jsonResponse({ error: 'Not Found' }, 404);
}

function methodNotAllowed() {
  return jsonResponse({ error: 'Method Not Allowed' }, 405);
}

function serverError(error) {
  return jsonResponse({ 
    error: 'Internal Server Error',
    message: error.message 
  }, 500);
}

function badRequest(message) {
  return jsonResponse({ 
    error: 'Bad Request',
    message 
  }, 400);
}

// ===== API Handlers =====
async function getFaces(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, name, vector, created_at, updated_at 
      FROM faces 
      ORDER BY name
    `).all();
    
    return jsonResponse({ 
      success: true,
      count: results.length,
      faces: results.map(face => ({
        ...face,
        vector: JSON.parse(face.vector)
      }))
    });
  } catch (error) {
    console.error('Get faces error:', error);
    return serverError(error);
  }
}

async function enrollFace(request, env) {
  try {
    const data = await request.json();
    const { name, vector } = data;
    
    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return badRequest('Name is required');
    }
    
    if (!vector || !Array.isArray(vector) || vector.length !== 256) {
      return badRequest('Vector must be an array of 256 floats');
    }
    
    const cleanName = name.trim();
    const vectorStr = JSON.stringify(vector);
    
    // Check if name already exists
    const existing = await env.DB.prepare(
      'SELECT id FROM faces WHERE name = ?'
    ).bind(cleanName).first();
    
    let result;
    if (existing) {
      // Update existing
      result = await env.DB.prepare(`
        UPDATE faces 
        SET vector = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE name = ?
      `).bind(vectorStr, cleanName).run();
    } else {
      // Insert new
      result = await env.DB.prepare(`
        INSERT INTO faces (name, vector) 
        VALUES (?, ?)
      `).bind(cleanName, vectorStr).run();
    }
    
    await logAction(env, { 
      name: cleanName, 
      action: existing ? 'update' : 'enroll' 
    });
    
    return jsonResponse({
      success: true,
      message: `Face ${existing ? 'updated' : 'enrolled'} successfully`,
      face_id: existing?.id || result.lastRowId,
      name: cleanName
    });
  } catch (error) {
    console.error('Enroll error:', error);
    return serverError(error);
  }
}

async function searchFace(request, env) {
  try {
    const data = await request.json();
    const { vector, threshold = 0.9 } = data;
    
    // Validation
    if (!vector || !Array.isArray(vector) || vector.length !== 256) {
      return badRequest('Vector must be an array of 256 floats');
    }
    
    // Get all faces from database
    const { results: faces } = await env.DB.prepare(`
      SELECT id, name, vector FROM faces
    `).all();
    
    let bestMatch = { 
      id: null, 
      name: 'Unknown', 
      confidence: 0 
    };
    
    // Compare with all faces
    for (const face of faces) {
      try {
        const faceVector = JSON.parse(face.vector);
        const confidence = cosineSimilarity(vector, faceVector);
        
        if (confidence > bestMatch.confidence) {
          bestMatch = {
            id: face.id,
            name: face.name,
            confidence: confidence
          };
        }
      } catch (parseError) {
        console.error('Vector parse error:', parseError);
        continue;
      }
    }
    
    const isMatch = bestMatch.confidence >= parseFloat(threshold);
    
    // Log the search
    await logAction(env, {
      face_id: bestMatch.id,
      name: bestMatch.name,
      confidence: bestMatch.confidence,
      action: 'search'
    });
    
    return jsonResponse({
      match: isMatch,
      ...bestMatch,
      threshold: parseFloat(threshold)
    });
  } catch (error) {
    console.error('Search error:', error);
    return serverError(error);
  }
}

async function recognizeFace(request, env) {
  try {
    // First search for the face
    const searchResult = await searchFace(request, env);
    const data = await searchResult.json();
    
    // If match found, trigger additional actions
    if (data.match) {
      console.log(`Face recognized: ${data.name} (confidence: ${data.confidence.toFixed(2)})`);
      
      // Here you could trigger IoT devices, send notifications, etc.
      // For example:
      // - Send webhook
      // - Trigger LED
      // - Send email/SMS
      
      // Log as recognition (not just search)
      await env.DB.prepare(`
        UPDATE access_logs 
        SET action = 'recognize'
        WHERE id = (
          SELECT id FROM access_logs 
          WHERE face_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).bind(data.id).run();
    }
    
    return jsonResponse(data);
  } catch (error) {
    console.error('Recognize error:', error);
    return serverError(error);
  }
}

async function batchEnroll(request, env) {
  try {
    const data = await request.json();
    const { faces } = data;
    
    if (!Array.isArray(faces)) {
      return badRequest('Faces must be an array');
    }
    
    const errors = [];
    const successes = [];
    
    // Process each face in batch
    for (const face of faces) {
      try {
        const { name, vector } = face;
        
        if (!name || !vector || !Array.isArray(vector) || vector.length !== 256) {
          errors.push({ name: face.name || 'unknown', error: 'Invalid data format' });
          continue;
        }
        
        const cleanName = name.trim();
        const vectorStr = JSON.stringify(vector);
        
        // Check if exists
        const existing = await env.DB.prepare(
          'SELECT id FROM faces WHERE name = ?'
        ).bind(cleanName).first();
        
        if (existing) {
          await env.DB.prepare(`
            UPDATE faces 
            SET vector = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE name = ?
          `).bind(vectorStr, cleanName).run();
        } else {
          await env.DB.prepare(`
            INSERT INTO faces (name, vector) 
            VALUES (?, ?)
          `).bind(cleanName, vectorStr).run();
        }
        
        successes.push(cleanName);
        
      } catch (faceError) {
        errors.push({ 
          name: face.name || 'unknown', 
          error: faceError.message 
        });
      }
    }
    
    // Log batch action
    await logAction(env, {
      action: 'batch_enroll',
      name: `Batch of ${successes.length} faces`
    });
    
    return jsonResponse({
      success: true,
      imported: successes.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Processed ${faces.length} faces, ${successes.length} successful, ${errors.length} failed`
    });
  } catch (error) {
    console.error('Batch enroll error:', error);
    return serverError(error);
  }
}

async function exportFaces(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, name, vector, created_at, updated_at 
      FROM faces 
      ORDER BY name
    `).all();
    
    // Parse vectors from JSON strings
    const faces = results.map(face => ({
      id: face.id,
      name: face.name,
      vector: JSON.parse(face.vector),
      created_at: face.created_at,
      updated_at: face.updated_at
    }));
    
    const exportData = {
      version: '1.0',
      format: 'LBP-256',
      count: faces.length,
      exported_at: new Date().toISOString(),
      labels: faces
    };
    
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="face_db.json"',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (error) {
    console.error('Export error:', error);
    return serverError(error);
  }
}

async function clearFaces(env) {
  try {
    // Get count before deletion for logging
    const facesCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM faces'
    ).first();
    
    const logsCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM access_logs'
    ).first();
    
    // Delete all data
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM access_logs').run();
    
    // Log the clear action
    await env.DB.prepare(`
      INSERT INTO access_logs (action, name)
      VALUES (?, ?)
    `).bind('clear_all', `Cleared ${facesCount.count} faces and ${logsCount.count} logs`).run();
    
    return jsonResponse({
      success: true,
      message: 'All data cleared successfully',
      cleared_faces: facesCount.count,
      cleared_logs: logsCount.count
    });
  } catch (error) {
    console.error('Clear error:', error);
    return serverError(error);
  }
}

async function controlLED(request) {
  try {
    const data = await request.json();
    const { state } = data;
    
    if (!state || !['on', 'off'].includes(state)) {
      return badRequest('State must be "on" or "off"');
    }
    
    // This is a mock implementation
    // In production, integrate with actual IoT service
    
    console.log(`LED control requested: ${state}`);
    
    // Simulate API call to IoT device
    const success = Math.random() > 0.1; // 90% success rate for demo
    
    if (!success) {
      return jsonResponse({
        success: false,
        message: 'Failed to control LED (simulated error)',
        state: state
      }, 500);
    }
    
    return jsonResponse({
      success: true,
      message: `LED turned ${state}`,
      state: state,
      timestamp: new Date().toISOString(),
      note: 'This is a mock implementation. Replace with actual IoT integration.'
    });
  } catch (error) {
    console.error('LED control error:', error);
    return serverError(error);
  }
}

async function getStats(env) {
  try {
    const [
      facesCount,
      logsCount,
      recentLogs,
      recentFaces
    ] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM faces').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM access_logs').first(),
      env.DB.prepare(`
        SELECT name, action, confidence, timestamp 
        FROM access_logs 
        ORDER BY timestamp DESC 
        LIMIT 10
      `).all(),
      env.DB.prepare(`
        SELECT name, created_at 
        FROM faces 
        ORDER BY created_at DESC 
        LIMIT 5
      `).all()
    ]);
    
    return jsonResponse({
      system: {
        database: 'D1',
        uptime: 'N/A', // Could track worker startup time
        region: 'auto' // Cloudflare auto-scales
      },
      statistics: {
        faces: facesCount.count,
        total_logs: logsCount.count,
        storage_used: 'N/A' // D1 doesn't expose this easily
      },
      recent_activity: {
        logs: recentLogs.results,
        recent_faces: recentFaces.results
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    return serverError(error);
  }
}

async function getLogs(request, env) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100);
    const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
    const action = url.searchParams.get('action');
    
    let query = 'SELECT * FROM access_logs';
    const params = [];
    
    if (action) {
      query += ' WHERE action = ?';
      params.push(action);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const { results } = await env.DB.prepare(query).bind(...params).all();
    
    const total = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM access_logs' + (action ? ' WHERE action = ?' : '')
    ).bind(...(action ? [action] : [])).first();
    
    const actions = await env.DB.prepare(
      'SELECT DISTINCT action FROM access_logs ORDER BY action'
    ).all();
    
    return jsonResponse({
      logs: results,
      pagination: {
        limit,
        offset,
        total: total.count,
        has_more: (offset + results.length) < total.count
      },
      filters: {
        available_actions: actions.results.map(a => a.action)
      }
    });
  } catch (error) {
    console.error('Logs error:', error);
    return serverError(error);
  }
}

// ===== Scheduled Trigger (for cleanup) =====
export async function scheduled(event, env, ctx) {
  ctx.waitUntil(cleanupOldLogs(env));
}

async function cleanupOldLogs(env) {
  try {
    // Keep only logs from last 30 days
    const result = await env.DB.prepare(`
      DELETE FROM access_logs 
      WHERE timestamp < datetime('now', '-30 days')
    `).run();
    
    console.log(`Cleaned up ${result.changes} old log entries`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}z