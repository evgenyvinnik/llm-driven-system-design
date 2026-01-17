/**
 * Skills section component displaying user's professional skills.
 * Shows a list of skills with endorsement counts and actions for adding,
 * removing, and endorsing skills.
 *
 * @module components/profile/SkillsSection
 */
import { useState } from 'react';
import { Plus, X, Check } from 'lucide-react';
import type { UserSkill } from '../../types';

/**
 * Props for the SkillsSection component.
 */
interface SkillsSectionProps {
  /** List of user's skills with endorsement counts */
  skills: UserSkill[];
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Callback when a skill is added (profile owner only) */
  onAddSkill: (skillName: string) => Promise<void>;
  /** Callback when a skill is removed (profile owner only) */
  onRemoveSkill: (skillId: number) => Promise<void>;
  /** Callback when a skill is endorsed (other users only) */
  onEndorseSkill: (skillId: number) => Promise<void>;
}

/**
 * Displays the "Skills" section of a user's profile.
 * Shows skill list with endorsements, and provides actions for
 * managing skills (for profile owner) or endorsing skills (for others).
 *
 * @param props - Component props
 * @returns The skills section JSX element
 */
export function SkillsSection({
  skills,
  isOwnProfile,
  onAddSkill,
  onRemoveSkill,
  onEndorseSkill,
}: SkillsSectionProps) {
  const [addingSkill, setAddingSkill] = useState(false);
  const [newSkill, setNewSkill] = useState('');

  /**
   * Handles the submission of a new skill.
   * Calls the onAddSkill callback and resets the form state.
   */
  const handleAddSkill = async () => {
    if (!newSkill.trim()) return;

    await onAddSkill(newSkill);
    setNewSkill('');
    setAddingSkill(false);
  };

  /**
   * Cancels the add skill form and resets state.
   */
  const handleCancelAdd = () => {
    setAddingSkill(false);
    setNewSkill('');
  };

  return (
    <div className="card p-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Skills</h2>
        {isOwnProfile && (
          <button
            onClick={() => setAddingSkill(true)}
            className="text-gray-600 hover:bg-gray-100 p-2 rounded-full"
            aria-label="Add skill"
          >
            <Plus className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Add skill form (shown when adding) */}
      {addingSkill && (
        <AddSkillForm
          newSkill={newSkill}
          onSkillChange={setNewSkill}
          onSave={handleAddSkill}
          onCancel={handleCancelAdd}
        />
      )}

      {/* Skills list or empty state */}
      {skills.length === 0 ? (
        <p className="text-gray-500">No skills added yet</p>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <SkillItem
              key={skill.skill_id}
              skill={skill}
              isOwnProfile={isOwnProfile}
              onRemove={() => onRemoveSkill(skill.skill_id)}
              onEndorse={() => onEndorseSkill(skill.skill_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Props for the AddSkillForm sub-component.
 */
interface AddSkillFormProps {
  /** Current value of the skill name input */
  newSkill: string;
  /** Callback when skill name changes */
  onSkillChange: (value: string) => void;
  /** Callback when save button is clicked */
  onSave: () => void;
  /** Callback when cancel button is clicked */
  onCancel: () => void;
}

/**
 * Form for adding a new skill to the profile.
 *
 * @param props - Component props
 * @returns The add skill form JSX element
 */
function AddSkillForm({
  newSkill,
  onSkillChange,
  onSave,
  onCancel,
}: AddSkillFormProps) {
  return (
    <div className="flex gap-2 mb-4">
      <input
        type="text"
        value={newSkill}
        onChange={(e) => onSkillChange(e.target.value)}
        placeholder="Enter skill name"
        className="input flex-1"
        aria-label="Skill name"
      />
      <button onClick={onSave} className="btn-primary" aria-label="Save skill">
        <Check className="w-4 h-4" />
      </button>
      <button onClick={onCancel} className="btn-secondary" aria-label="Cancel adding skill">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Props for the SkillItem sub-component.
 */
interface SkillItemProps {
  /** The skill to display */
  skill: UserSkill;
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Callback when remove button is clicked */
  onRemove: () => void;
  /** Callback when endorse button is clicked */
  onEndorse: () => void;
}

/**
 * Displays a single skill entry with name, endorsement count, and actions.
 *
 * @param props - Component props
 * @returns The skill item JSX element
 */
function SkillItem({ skill, isOwnProfile, onRemove, onEndorse }: SkillItemProps) {
  return (
    <div className="flex items-center justify-between p-3 bg-gray-50 rounded">
      <div>
        <div className="font-medium">{skill.skill_name}</div>
        {skill.endorsement_count > 0 && (
          <div className="text-sm text-gray-500">
            {skill.endorsement_count} endorsement
            {skill.endorsement_count > 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        {/* Show endorse button for non-owners */}
        {!isOwnProfile && (
          <button
            onClick={onEndorse}
            className="text-sm text-linkedin-blue hover:underline"
          >
            Endorse
          </button>
        )}

        {/* Show remove button for profile owner */}
        {isOwnProfile && (
          <button
            onClick={onRemove}
            className="text-gray-400 hover:text-red-600"
            aria-label={`Remove ${skill.skill_name} skill`}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
