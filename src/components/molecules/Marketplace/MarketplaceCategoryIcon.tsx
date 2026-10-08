import { Camera, Disc3, Footprints, Gem, House, Keyboard, Package, Shirt } from 'lucide-react';
import { cn } from '@/libs/utils/utils';

export function MarketplaceCategoryIcon({
  categoryId = '',
  className: classNameOverride,
}: {
  categoryId?: string;
  className?: string;
}) {
  const className = cn(
    'size-20 text-foreground opacity-75 drop-shadow-xl transition-transform group-hover:scale-105',
    classNameOverride,
  );
  switch (true) {
    case categoryId.includes('camera'):
      return <Camera aria-hidden="true" className={className} />;
    case categoryId.includes('vinyl'):
      return <Disc3 aria-hidden="true" className={className} />;
    case categoryId.includes('shoes'):
      return <Footprints aria-hidden="true" className={className} />;
    case categoryId.includes('jewelry'):
      return <Gem aria-hidden="true" className={className} />;
    case categoryId.includes('home'):
      return <House aria-hidden="true" className={className} />;
    case categoryId.includes('keyboard'):
      return <Keyboard aria-hidden="true" className={className} />;
    case categoryId.includes('fashion'):
      return <Shirt aria-hidden="true" className={className} />;
    default:
      return <Package aria-hidden="true" className={className} />;
  }
}
