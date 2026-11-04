/**
 * İkon kutusu tonları (KPI hücresi, hızlı bakış satırı, bölüm listesi). Varsayılan nötr taş; renk yalnız anlam
 * taşıyınca (DESIGN.md §1.2): violet online sipariş, blue açık / dolu (açık adisyon, dolu masa), green ciro ve
 * canlı / olumlu durum (satışta, bağlı), rose kayıp / iptal (indirim, ikram, kaçan sipariş), amber gecikme ve
 * bekleyen (yavaş hazırlama, açık platform siparişi). Durumsuz sayı ve süre nötr
 */
export type Hue = 'neutral' | 'blue' | 'amber' | 'rose' | 'violet' | 'green';
