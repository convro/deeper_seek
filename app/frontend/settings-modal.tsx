import React, { useEffect, useState } from 'react';
import type { UserSettings } from './api';

interface SettingsModalProps {
  settings: UserSettings;
  onSave: (settings: UserSettings) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, onSave, onClose }: SettingsModalProps) {
  const [local, setLocal] = useState<UserSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(local);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: keyof UserSettings) =>
    setLocal(s => ({ ...s, [key]: !s[key] }));

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-label">Model</div>

            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-name">Extended Thinking</div>
                <div className="settings-row-desc">
                  {local.extended_thinking
                    ? 'DeepSeek-R1 — deep chain-of-thought reasoning. Best for complex tasks, slower.'
                    : 'DeepSeek-Chat — fast responses. Great for quick tasks and iterating.'}
                </div>
              </div>
              <button
                className={`settings-toggle ${local.extended_thinking ? 'on' : 'off'}`}
                onClick={() => toggle('extended_thinking')}
                aria-pressed={local.extended_thinking}
                title={local.extended_thinking ? 'Turn off' : 'Turn on'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-name">Agent Extended Thinking</div>
                <div className="settings-row-desc">
                  {local.agent_extended_thinking
                    ? 'Specialist agents (planner, validator) use DeepSeek-R1. More thorough, slower.'
                    : 'All agents use DeepSeek-Chat. Faster parallel execution, lighter tasks.'}
                </div>
              </div>
              <button
                className={`settings-toggle ${local.agent_extended_thinking ? 'on' : 'off'}`}
                onClick={() => toggle('agent_extended_thinking')}
                aria-pressed={local.agent_extended_thinking}
                title={local.agent_extended_thinking ? 'Turn off' : 'Turn on'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="settings-cancel-btn" onClick={onClose}>Cancel</button>
          <button className="settings-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
