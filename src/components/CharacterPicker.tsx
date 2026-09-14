import type { CharacterId } from "../../shared/contracts.ts";
import { CHARACTERS, characterFor, characterImage } from "../../shared/characters.ts";

export function CharacterPicker({ value, onChange, disabled = false }: {
  value: CharacterId; onChange(id: CharacterId): void; disabled?: boolean;
}) {
  return <fieldset className="character-picker" disabled={disabled}>
    <legend>나의 캐릭터 <span>{characterFor(value).name}</span></legend>
    <div className="character-options">
      {CHARACTERS.map((character) => <button key={character.id} type="button"
        aria-label={`${character.name} 선택`} aria-pressed={value === character.id}
        title={character.description} onClick={() => onChange(character.id)}>
        <img src={characterImage(character.id)} alt="" loading="lazy" />
        <span>{character.name}</span>
      </button>)}
    </div>
    <p>{characterFor(value).description}</p>
  </fieldset>;
}
