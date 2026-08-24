import React, { useRef, useState } from 'react';

// Square, capped at this size regardless of what was uploaded -- resized and
// cropped client-side so every dashboard only ever loads a small, predictable
// image instead of whatever resolution a phone camera produced.
const AVATAR_SIZE = 160;

function initialsOf(name) {
  return String(name || '').trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2) || '?';
}

// File -> a square JPEG data URL, cropped to cover (not squashed) and capped
// at AVATAR_SIZE. Done here, not on the server, since there's no image
// library in this stack and a canvas does the whole job for free.
function resizeToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(AVATAR_SIZE / img.width, AVATAR_SIZE / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (AVATAR_SIZE - w) / 2, (AVATAR_SIZE - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Circular avatar, click-to-upload, hover-to-remove. Self-service only -- it
// always uploads to the logged-in account (the server ignores anything else),
// so this never needs to know or ask whose photo it's editing.
export default function ProfilePhoto({ user, photo, onPhotoChange, size = 44 }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again later
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file'); return; }
    setBusy(true);
    try {
      const dataUrl = await resizeToDataUrl(file);
      const res = await fetch('/api/user/photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoData: dataUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload photo');
      onPhotoChange(dataUrl);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (e) => {
    e.stopPropagation();
    if (!confirm('Remove your profile photo?')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/user/photo', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove photo');
      onPhotoChange(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => !busy && inputRef.current?.click()}
      title="Click to change your photo"
      style={{
        position: 'relative', width: size, height: size, borderRadius: '50%',
        cursor: busy ? 'wait' : 'pointer', flexShrink: 0,
        overflow: 'visible', border: '2px solid var(--glass-border)',
        background: photo ? 'transparent' : 'var(--color-indigo)',
      }}
    >
      <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {photo ? (
          <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.4 }}>{initialsOf(user.name)}</span>
        )}
        {(hover || busy) && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: size * 0.35, color: '#fff'
          }}>
            {busy ? '…' : '📷'}
          </div>
        )}
      </div>
      {photo && hover && !busy && (
        <button
          onClick={handleRemove}
          title="Remove photo"
          style={{
            position: 'absolute', top: -2, right: -2, width: '18px', height: '18px',
            borderRadius: '50%', background: '#f43f5e', color: '#fff', border: 'none',
            fontSize: '0.65rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1, padding: 0
          }}
        >
          ✕
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
    </div>
  );
}
