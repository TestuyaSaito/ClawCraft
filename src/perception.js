// ═══════════════════════════════════════════════════════════════
// PERCEPTION SERVICE — SCV spatial awareness (coordinate-based)
// ═══════════════════════════════════════════════════════════════

function angleDeg(dx, dy) {
  return ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
}

function distanceBetween(ax, ay, bx, by) {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

// Relative bearing from agent's heading to target (-180 to 180)
function relativeBearing(headingDeg, targetDeg) {
  let diff = targetDeg - headingDeg;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function classifySide(bearing) {
  if (bearing < -15) return 'left';
  if (bearing > 15) return 'right';
  return 'front';
}

function classifySector(bearing, distance) {
  const fb = Math.abs(bearing) < 60 ? 'front' : Math.abs(bearing) < 120 ? 'side' : 'rear';
  const lr = bearing < -15 ? 'left' : bearing > 15 ? 'right' : 'center';
  const dist = distance < 80 ? 'near' : distance < 200 ? 'mid' : 'far';
  return `${fb}-${lr} (${dist})`;
}

// Build perception for one agent given world objects
function buildPerception(agent, worldObjects, visionRadius) {
  const rad = visionRadius || 400;
  const headingDeg = (agent.vDir || 0) * 22.5; // dir16 → degrees (0=East)

  const visible = [];
  for (const obj of worldObjects) {
    if (obj.id === agent.id && obj.type === 'agent') continue; // skip self
    const dist = distanceBetween(agent.x, agent.y, obj.x, obj.y);
    if (dist > rad) continue;
    const targetDeg = angleDeg(obj.x - agent.x, obj.y - agent.y);
    const bearing = relativeBearing(headingDeg, targetDeg);
    visible.push({
      type: obj.type,
      id: obj.id || null,
      label: obj.label || obj.name || obj.type,
      x: Math.round(obj.x),
      y: Math.round(obj.y),
      distance: Math.round(dist),
      bearing: Math.round(bearing),
      side: classifySide(bearing),
      sector: classifySector(bearing, dist),
    });
  }

  visible.sort((a, b) => a.distance - b.distance);

  const nearbyTeammates = visible.filter(v => v.type === 'agent').map(v => v.label);
  const nearestLeft = visible.find(v => v.side === 'left') || null;
  const nearestRight = visible.find(v => v.side === 'right') || null;
  const nearestFront = visible.find(v => v.side === 'front') || null;

  return {
    self: {
      id: agent.id,
      name: agent.nickname || agent.displayName || agent.name,
      x: Math.round(agent.x),
      y: Math.round(agent.y),
      headingDeg: Math.round(headingDeg),
    },
    visible: visible.slice(0, 15),
    nearbyTeammates,
    nearestLeft: nearestLeft?.label || null,
    nearestRight: nearestRight?.label || null,
    nearestFront: nearestFront?.label || null,
    objectCount: visible.length,
  };
}

// Format perception as text for LLM prompt
function perceptionToText(perception) {
  if (!perception) return '';
  const p = perception;
  let text = `## Your surroundings\n`;
  text += `Position: (${p.self.x}, ${p.self.y}), heading: ${p.self.headingDeg}°\n`;
  if (p.nearestLeft) text += `Nearest left: ${p.nearestLeft}\n`;
  if (p.nearestRight) text += `Nearest right: ${p.nearestRight}\n`;
  if (p.nearestFront) text += `Nearest front: ${p.nearestFront}\n`;
  if (p.nearbyTeammates.length > 0) text += `Nearby teammates: ${p.nearbyTeammates.join(', ')}\n`;
  if (p.visible.length > 0) {
    text += `\nVisible objects (${p.objectCount}):\n`;
    p.visible.forEach(v => {
      text += `- ${v.label} [${v.type}] — ${v.distance}px ${v.sector}\n`;
    });
  }
  text += '\n';
  return text;
}
