// Bundled provider marks; see public/licenses/provider-logos.json for provenance.

import type { ProviderName } from '@/lib/providers'
import { GLogo } from '@/icons/GLogo'
import providerLogos from '@/icons/providers/sprite.svg'

interface Props {
  provider: ProviderName
  size?: number
}

export function ProviderTile({ provider, size = 26 }: Props) {
  return (
    <span
      aria-hidden
      data-provider-logo={provider}
      style={{
        width: size,
        height: size,
        color: 'var(--text-primary)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {provider === 'local' ? <GLogo size={size} /> : (
        <svg width={size} height={size} focusable="false">
          <use href={`${providerLogos}#${provider}`} width="100%" height="100%" />
        </svg>
      )}
    </span>
  )
}
