-- seed.sql  (runs on `supabase db reset`, LOCAL ONLY. Never run against staging/production.)
--
-- ############################################################################################
-- #  PLACEHOLDER DATA. The menu, prices, products, phone numbers and settings below are       #
-- #  invented so frontend and QA can work. None of it is the cafe's real offer. The real      #
-- #  menu and prices come from the client. Prices are integer paisa (Rs. 150 = 15000).        #
-- #  No staff/auth users are seeded on purpose (no known passwords in the repo): create a     #
-- #  local owner with the snippet in supabase/README.md.                                      #
-- ############################################################################################

-- Settings -----------------------------------------------------------------------------------------------
update public.site_settings set
  cafe_name = 'Nailed Cafe (placeholder)',
  announcement = 'DEMO DATA: placeholder menu and prices, not real.',
  hours = jsonb_build_object(
    'weekly', jsonb_build_object(
      '0', jsonb_build_array(jsonb_build_object('open', '08:00', 'close', '20:00')),
      '1', jsonb_build_array(jsonb_build_object('open', '07:00', 'close', '21:00')),
      '2', jsonb_build_array(jsonb_build_object('open', '07:00', 'close', '21:00')),
      '3', jsonb_build_array(jsonb_build_object('open', '07:00', 'close', '21:00')),
      '4', jsonb_build_array(jsonb_build_object('open', '07:00', 'close', '21:00')),
      '5', jsonb_build_array(jsonb_build_object('open', '07:00', 'close', '21:00')),
      '6', null),                                             -- placeholder: closed Saturday
    'closures', jsonb_build_array(jsonb_build_object('date', '2026-10-21', 'label', 'Dashain (placeholder)'))),
  phone = '+9779800000000', whatsapp = '+9779800000000', email = 'hello@example.invalid',
  address = 'Placeholder Road, Kathmandu', landmark = 'Near the placeholder chowk',
  prices_include_vat = true, service_charge_pct = 0,
  delivery_fee_paisa = 15000,
  delivery_areas = array['Thamel', 'Lazimpat', 'Baneshwor', 'Jawalakhel'],
  payment_methods_enabled = array['cod', 'pickup'],
  min_order_delivery_paisa = 50000,
  min_order_pickup_paisa = 0;

update public.order_rules set
  cod_max_total_paisa = 1000000,        -- Rs. 10,000 (placeholder)
  max_open_orders_per_phone = 2;

-- Menu categories ----------------------------------------------------------------------------------------
insert into public.menu_categories (id, slug, name, sort_order) values
  ('10000000-0000-4000-8000-000000000001', 'coffee',            'Coffee',             1),
  ('10000000-0000-4000-8000-000000000002', 'tea',               'Tea',                2),
  ('10000000-0000-4000-8000-000000000003', 'momo',              'Momo',               3),
  ('10000000-0000-4000-8000-000000000004', 'snacks-breakfast',  'Snacks & Breakfast', 4),
  ('10000000-0000-4000-8000-000000000005', 'desserts',          'Desserts',           5),
  ('10000000-0000-4000-8000-000000000006', 'cold-drinks',       'Cold Drinks',        6);

-- Menu items (21, placeholder prices) --------------------------------------------------------------------
insert into public.menu_items (id, category_id, name, description, price_paisa, diet, tags, is_sold_out, sort_order) values
  -- Coffee
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Espresso',          'Short, strong, single shot.',                       15000, 'veg',     '{}',                         false, 1),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Americano',         'Espresso topped with hot water.',                   18000, 'veg',     '{}',                         false, 2),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Cappuccino',        'Espresso, steamed milk, thick foam.',               22000, 'veg',     '{bestseller}',               false, 3),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Cafe Latte',        'Smooth and milky, served hot or iced.',             24000, 'veg',     '{}',                         false, 4),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Iced Coffee',       'Cold brew style over ice with a splash of milk.',   26000, 'veg',     '{new}',                      false, 5),
  -- Tea
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'Masala Chai',       'Milk tea with ginger, cardamom and spice.',          9000, 'veg',     '{bestseller}',               false, 1),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002', 'Lemon Tea',         'Black tea, lemon, honey on the side.',               8000, 'veg',     '{}',                         false, 2),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002', 'Himalayan Green Tea','Light green tea, served in a pot.',               14000, 'veg',     '{new}',                      true,  3),  -- sold out on purpose
  -- Momo
  ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000003', 'Steam Chicken Momo','10 pieces with tomato achar.',                     22000, 'non_veg', '{bestseller}',               false, 1),
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000003', 'Veg Momo',          '10 pieces, cabbage and paneer filling.',            18000, 'veg',     '{}',                         false, 2),
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000003', 'Buff Momo',         '10 pieces, classic buff filling.',                  20000, 'non_veg', '{}',                         false, 3),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000003', 'Jhol Momo',         'Momo in warm, spicy sesame-tomato jhol.',           25000, 'non_veg', '{spicy,chef_pick}',          false, 4),
  -- Snacks & Breakfast
  ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000004', 'Chicken Chowmein',  'Stir-fried noodles, chicken, vegetables.',          25000, 'non_veg', '{}',                         false, 1),
  ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000004', 'French Fries',      'Crisp fries with salt and ketchup.',                16000, 'veg',     '{}',                         false, 2),
  ('20000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000004', 'Aloo Paratha',      'Potato-stuffed flatbread with curd and pickle.',    16000, 'veg',     '{}',                         false, 3),
  ('20000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000004', 'Egg Sandwich',      'Fried egg, cheese, toasted bread.',                 20000, 'egg',     '{}',                         false, 4),
  ('20000000-0000-4000-8000-000000000017', '10000000-0000-4000-8000-000000000004', 'Sel Roti with Aloo Tarkari','Ring-shaped rice bread with potato curry.',15000, 'veg',     '{chef_pick}',                false, 5),
  -- Desserts
  ('20000000-0000-4000-8000-000000000018', '10000000-0000-4000-8000-000000000005', 'Chocolate Brownie', 'Warm brownie, dark chocolate.',                    18000, 'egg',     '{}',                         false, 1),
  ('20000000-0000-4000-8000-000000000019', '10000000-0000-4000-8000-000000000005', 'Gulab Jamun',       'Two pieces in sugar syrup.',                        12000, 'veg',     '{}',                         false, 2),
  -- Cold drinks
  ('20000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000006', 'Mango Lassi',       'Thick curd drink with mango.',                      18000, 'veg',     '{bestseller}',               false, 1),
  ('20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000006', 'Fresh Lemon Soda',  'Sweet, salty or mixed.',                            12000, 'veg',     '{}',                         false, 2);

insert into public.menu_variants (item_id, kind, label, price_delta_paisa, is_sold_out, sort_order) values
  ('20000000-0000-4000-8000-000000000002', 'size',        'Large',       4000, false, 1),
  ('20000000-0000-4000-8000-000000000003', 'size',        'Large',       4000, false, 1),
  ('20000000-0000-4000-8000-000000000003', 'milk',        'Oat milk',    6000, true,  2),   -- variant sold out on purpose
  ('20000000-0000-4000-8000-000000000004', 'temperature', 'Iced',        3000, false, 1),
  ('20000000-0000-4000-8000-000000000004', 'milk',        'Oat milk',    6000, false, 2),
  ('20000000-0000-4000-8000-000000000006', 'size',        'Large',       3000, false, 1),
  ('20000000-0000-4000-8000-000000000009', 'addon',       'Extra achar', 3000, false, 1);
  -- No "Extra jhol" add-on: Jhol Momo is sold as one item only (Aabhash, 2026-10-24).

-- Menu translations (secondary languages, migration 20261024000001) ----------------------------------------
-- Generated from design/copy/menu-translations-2026-10-24.json (translator, 2026-10-24, DRAFT: needs Aabhash's
-- approval; zh/ja/ko/pt need native-speaker review). PLACEHOLDER menu, like everything above. Categories by slug,
-- items by seed id (English name in the comment), variants by English label. Keep in step with that file.
update public.menu_categories c set translations = v.t::jsonb from (values
  ('coffee', '{"ne": {"name": "कफी"}, "zh": {"name": "咖啡"}, "ja": {"name": "コーヒー"}, "ko": {"name": "커피"}, "pt": {"name": "Cafés"}}'),
  ('tea', '{"ne": {"name": "चिया"}, "zh": {"name": "茶饮"}, "ja": {"name": "ティー"}, "ko": {"name": "티"}, "pt": {"name": "Chás"}}'),
  ('momo', '{"ne": {"name": "मम"}, "zh": {"name": "馍馍（尼泊尔饺子）"}, "ja": {"name": "モモ（ネパール餃子）"}, "ko": {"name": "모모 (네팔식 만두)"}, "pt": {"name": "Momos (bolinhos nepaleses)"}}'),
  ('snacks-breakfast', '{"ne": {"name": "खाजा र नास्ता"}, "zh": {"name": "小食与早餐"}, "ja": {"name": "軽食・朝食"}, "ko": {"name": "스낵 & 아침 식사"}, "pt": {"name": "Lanches & Café da manhã"}}'),
  ('desserts', '{"ne": {"name": "डेजर्ट"}, "zh": {"name": "甜品"}, "ja": {"name": "デザート"}, "ko": {"name": "디저트"}, "pt": {"name": "Sobremesas"}}'),
  ('cold-drinks', '{"ne": {"name": "चिसो पेय"}, "zh": {"name": "冷饮"}, "ja": {"name": "コールドドリンク"}, "ko": {"name": "차가운 음료"}, "pt": {"name": "Bebidas geladas"}}')
) as v (slug, t) where c.slug = v.slug;

update public.menu_items i set translations = v.t::jsonb from (values
  -- Espresso
  ('20000000-0000-4000-8000-000000000001'::uuid, '{"ne": {"name": "एस्प्रेसो", "description": "सानो र कडा, एउटा सट।", "pronunciation": "espresso"}, "zh": {"name": "意式浓缩咖啡", "description": "量少味浓，单份浓缩。"}, "ja": {"name": "エスプレッソ", "description": "少量で濃い、シングルショット。"}, "ko": {"name": "에스프레소", "description": "짧고 진한 싱글 샷."}, "pt": {"name": "Espresso", "description": "Curto, forte, dose única."}}'),
  -- Americano
  ('20000000-0000-4000-8000-000000000002'::uuid, '{"ne": {"name": "अमेरिकानो", "description": "एस्प्रेसोमा तातो पानी थपेको।", "pronunciation": "amerikano"}, "zh": {"name": "美式咖啡", "description": "浓缩咖啡加热水。"}, "ja": {"name": "アメリカーノ", "description": "エスプレッソをお湯で割りました。"}, "ko": {"name": "아메리카노", "description": "에스프레소에 뜨거운 물을 더했어요."}, "pt": {"name": "Americano", "description": "Espresso completado com água quente."}}'),
  -- Cappuccino
  ('20000000-0000-4000-8000-000000000003'::uuid, '{"ne": {"name": "क्यापुचिनो", "description": "एस्प्रेसो, स्टिम गरेको दूध र बाक्लो फिँज।", "pronunciation": "kyapuchino"}, "zh": {"name": "卡布奇诺", "description": "浓缩咖啡、蒸奶，再加厚厚的奶泡。"}, "ja": {"name": "カプチーノ", "description": "エスプレッソ、スチームミルク、たっぷりのフォーム。"}, "ko": {"name": "카푸치노", "description": "에스프레소, 스팀 밀크, 두툼한 우유 거품."}, "pt": {"name": "Cappuccino", "description": "Espresso, leite vaporizado e espuma densa."}}'),
  -- Cafe Latte
  ('20000000-0000-4000-8000-000000000004'::uuid, '{"ne": {"name": "क्याफे लाटे", "description": "नरम र दूधिलो, तातो वा बरफ हालेर पाइन्छ।", "pronunciation": "kyafe laate"}, "zh": {"name": "拿铁咖啡", "description": "顺滑奶香，可选热饮或冰饮。"}, "ja": {"name": "カフェラテ", "description": "なめらかでミルキー。ホットまたはアイスで。"}, "ko": {"name": "카페라테", "description": "부드럽고 우유 맛이 풍부해요. 핫 또는 아이스."}, "pt": {"name": "Café Latte", "description": "Suave e com bastante leite, quente ou gelado."}}'),
  -- Iced Coffee
  ('20000000-0000-4000-8000-000000000005'::uuid, '{"ne": {"name": "आइस्ड कफी", "description": "कोल्ड ब्रु शैलीको कफी, बरफमाथि थोरै दूध हालेर।", "pronunciation": "aaisd kafi"}, "zh": {"name": "冰咖啡", "description": "冷萃风格，倒在冰上，再加少许牛奶。"}, "ja": {"name": "アイスコーヒー", "description": "コールドブリュー風を氷に注ぎ、ミルクを少し。"}, "ko": {"name": "아이스 커피", "description": "콜드브루 스타일로 얼음 위에, 우유를 살짝."}, "pt": {"name": "Café Gelado", "description": "Estilo cold brew, servido com gelo e um pouco de leite."}}'),
  -- Masala Chai
  ('20000000-0000-4000-8000-000000000006'::uuid, '{"ne": {"name": "मसला चिया", "description": "अदुवा, सुकमेल र मसला हालेको दूध चिया।", "pronunciation": "masala chiya"}, "zh": {"name": "马萨拉香料奶茶", "description": "加了姜、小豆蔻和香料的奶茶。"}, "ja": {"name": "マサラチャイ", "description": "生姜、カルダモン、スパイス入りのミルクティー。"}, "ko": {"name": "마살라 차이", "description": "생강, 카다멈, 향신료를 넣은 밀크티."}, "pt": {"name": "Masala Chai", "description": "Chá com leite, gengibre, cardamomo e especiarias."}}'),
  -- Lemon Tea
  ('20000000-0000-4000-8000-000000000007'::uuid, '{"ne": {"name": "लेमन टी", "description": "कालो चिया र कागती, मह छुट्टै।", "pronunciation": "leman ti"}, "zh": {"name": "柠檬茶", "description": "红茶配柠檬，蜂蜜另附。"}, "ja": {"name": "レモンティー", "description": "紅茶とレモン。はちみつは別添えで。"}, "ko": {"name": "레몬 티", "description": "홍차와 레몬, 꿀은 따로 드려요."}, "pt": {"name": "Chá de Limão", "description": "Chá preto e limão, com mel à parte."}}'),
  -- Himalayan Green Tea
  ('20000000-0000-4000-8000-000000000008'::uuid, '{"ne": {"name": "हिमालयन ग्रिन टी", "description": "हल्का हरियो चिया, केत्लीमा ल्याइन्छ।", "pronunciation": "himalayan grin ti"}, "zh": {"name": "喜马拉雅绿茶", "description": "清淡绿茶，整壶奉上。"}, "ja": {"name": "ヒマラヤン・グリーンティー", "description": "すっきりとした緑茶をポットで。"}, "ko": {"name": "히말라야 녹차", "description": "은은한 녹차, 포트에 담아 드려요."}, "pt": {"name": "Chá Verde do Himalaia", "description": "Chá verde suave, servido no bule."}}'),
  -- Steam Chicken Momo
  ('20000000-0000-4000-8000-000000000009'::uuid, '{"ne": {"name": "स्टिम चिकेन मम", "description": "१० वटा, गोलभेडाको अचारसँग।", "pronunciation": "stim chikan momo"}, "zh": {"name": "蒸鸡肉馍馍", "description": "10个，配番茄阿查酱。"}, "ja": {"name": "スチーム・チキンモモ", "description": "10個。トマトのアチャール添え。"}, "ko": {"name": "치킨 찐 모모", "description": "10개, 토마토 아차르와 함께."}, "pt": {"name": "Momo de Frango no Vapor", "description": "10 unidades, com achar de tomate."}}'),
  -- Veg Momo
  ('20000000-0000-4000-8000-000000000010'::uuid, '{"ne": {"name": "भेज मम", "description": "१० वटा, भित्र बन्दा र पनिर।", "pronunciation": "bhej momo"}, "zh": {"name": "素馍馍", "description": "10个，卷心菜和鲜奶酪（帕尼尔）馅。"}, "ja": {"name": "ベジ・モモ", "description": "10個。キャベツとパニール（フレッシュチーズ）入り。"}, "ko": {"name": "베지 모모", "description": "10개, 양배추와 파니르(생치즈) 소."}, "pt": {"name": "Momo Vegetariano", "description": "10 unidades, recheio de repolho e paneer (queijo fresco)."}}'),
  -- Buff Momo
  ('20000000-0000-4000-8000-000000000011'::uuid, '{"ne": {"name": "बफ मम", "description": "१० वटा, भित्र बफको मासु, पुरानै स्वाद।", "pronunciation": "baf momo"}, "zh": {"name": "Buff 馍馍", "description": "10个，经典 buff 馅。"}, "ja": {"name": "バフ・モモ", "description": "10個。定番のバフ入り。"}, "ko": {"name": "버프 모모", "description": "10개, 클래식 버프 소."}, "pt": {"name": "Buff Momo", "description": "10 unidades, recheio clássico de buff."}}'),
  -- Jhol Momo
  ('20000000-0000-4000-8000-000000000012'::uuid, '{"ne": {"name": "झोल मम", "description": "तातो, पिरो तिल-गोलभेडाको झोलमा मम।", "pronunciation": "jhol momo"}, "zh": {"name": "Jhol 馍馍", "description": "馍馍泡在温热香辣的芝麻番茄 jhol 里。"}, "ja": {"name": "ジョル・モモ", "description": "温かくスパイシーなごまトマトのジョルに浸したモモ。"}, "ko": {"name": "졸 모모", "description": "따뜻하고 매콤한 참깨 토마토 졸에 담긴 모모."}, "pt": {"name": "Jhol Momo", "description": "Momos num jhol quente e picante de gergelim e tomate."}}'),
  -- Chicken Chowmein
  ('20000000-0000-4000-8000-000000000013'::uuid, '{"ne": {"name": "चिकेन चाउमिन", "description": "भुटेको नुडल्स, चिकेन र तरकारी।", "pronunciation": "chikan chaumin"}, "zh": {"name": "鸡肉炒面", "description": "炒面配鸡肉和蔬菜。"}, "ja": {"name": "チキン・チャウミン（焼きそば）", "description": "鶏肉と野菜の炒め麺。"}, "ko": {"name": "치킨 차우멘 (볶음면)", "description": "닭고기와 채소를 넣고 볶은 면."}, "pt": {"name": "Chow Mein de Frango", "description": "Macarrão salteado com frango e legumes."}}'),
  -- French Fries
  ('20000000-0000-4000-8000-000000000014'::uuid, '{"ne": {"name": "फ्रेन्च फ्राइज", "description": "नुन र केचपसँग क्रिस्पी फ्राइज।", "pronunciation": "french fraij"}, "zh": {"name": "炸薯条", "description": "酥脆薯条，配盐和番茄酱。"}, "ja": {"name": "フライドポテト", "description": "カリッと揚げたポテト。塩とケチャップで。"}, "ko": {"name": "감자튀김", "description": "바삭한 감자튀김, 소금과 케첩과 함께."}, "pt": {"name": "Batata Frita", "description": "Batatas fritas crocantes com sal e ketchup."}}'),
  -- Aloo Paratha
  ('20000000-0000-4000-8000-000000000015'::uuid, '{"ne": {"name": "आलु पराठा", "description": "आलु भरिएको पराठा, दही र अचारसँग।", "pronunciation": "aalu paratha"}, "zh": {"name": "土豆帕拉塔", "description": "土豆馅烤饼，配酸奶和腌菜。"}, "ja": {"name": "アルー・パラタ", "description": "ジャガイモを包んだ平焼きパン。ヨーグルトとピクルス添え。"}, "ko": {"name": "알루 파라타 (감자 플랫브레드)", "description": "감자로 속을 채운 납작빵, 요거트와 피클을 곁들여요."}, "pt": {"name": "Aloo Paratha (pão recheado de batata)", "description": "Pão achatado recheado de batata, com coalhada e picles."}}'),
  -- Egg Sandwich
  ('20000000-0000-4000-8000-000000000016'::uuid, '{"ne": {"name": "एग स्यान्डविच", "description": "तारेको अण्डा, चिज र टोस्ट गरेको पाउरोटी।", "pronunciation": "eg syandwich"}, "zh": {"name": "鸡蛋三明治", "description": "煎蛋、芝士、烤面包。"}, "ja": {"name": "エッグサンド", "description": "目玉焼き、チーズ、トーストしたパン。"}, "ko": {"name": "에그 샌드위치", "description": "달걀 프라이, 치즈, 구운 빵."}, "pt": {"name": "Sanduíche de Ovo", "description": "Ovo frito, queijo e pão tostado."}}'),
  -- Sel Roti with Aloo Tarkari
  ('20000000-0000-4000-8000-000000000017'::uuid, '{"ne": {"name": "सेल रोटी र आलुको तरकारी", "description": "चामलको पिठोबाट बनेको सेल रोटी, आलुको तरकारीसँग।", "pronunciation": "sel roti ra aalu ko tarkari"}, "zh": {"name": "塞尔罗提（尼泊尔米圈）配土豆咖喱", "description": "环形米饼，配土豆咖喱。"}, "ja": {"name": "セル・ロティとアルー・タルカリ", "description": "米粉で作るリング状のパンに、ジャガイモのカレーを添えて。"}, "ko": {"name": "셀 로티와 알루 타르카리", "description": "쌀로 만든 링 모양 빵과 감자 커리."}, "pt": {"name": "Sel Roti com Aloo Tarkari", "description": "Pão de arroz em formato de anel, com curry de batata."}}'),
  -- Chocolate Brownie
  ('20000000-0000-4000-8000-000000000018'::uuid, '{"ne": {"name": "चकलेट ब्राउनी", "description": "तातो ब्राउनी, डार्क चकलेट।", "pronunciation": "chakalet brauni"}, "zh": {"name": "巧克力布朗尼", "description": "温热布朗尼，黑巧克力。"}, "ja": {"name": "チョコレートブラウニー", "description": "温かいブラウニー、ダークチョコレートで。"}, "ko": {"name": "초콜릿 브라우니", "description": "따뜻한 브라우니, 다크 초콜릿."}, "pt": {"name": "Brownie de Chocolate", "description": "Brownie quentinho de chocolate meio amargo."}}'),
  -- Gulab Jamun
  ('20000000-0000-4000-8000-000000000019'::uuid, '{"ne": {"name": "लालमोहन (गुलाब जामुन)", "description": "चास्नीमा दुई वटा।", "pronunciation": "lalmohan (gulab jamun)"}, "zh": {"name": "古拉布贾蒙", "description": "糖浆浸泡，两颗。"}, "ja": {"name": "グラブジャムン", "description": "シロップ漬け、2個。"}, "ko": {"name": "굴랍 자문", "description": "설탕 시럽에 담근 두 개."}, "pt": {"name": "Gulab Jamun", "description": "Dois bolinhos em calda de açúcar."}}'),
  -- Mango Lassi
  ('20000000-0000-4000-8000-000000000020'::uuid, '{"ne": {"name": "म्याङ्गो लस्सी", "description": "आँप मिसाइएको, दहीबाट बनेको बाक्लो पेय।", "pronunciation": "myango lassi"}, "zh": {"name": "芒果拉西", "description": "浓稠的酸奶饮品，加芒果。"}, "ja": {"name": "マンゴーラッシー", "description": "マンゴー入りの濃厚なヨーグルトドリンク。"}, "ko": {"name": "망고 라씨", "description": "망고를 넣은 진한 요거트 음료."}, "pt": {"name": "Lassi de Manga", "description": "Bebida cremosa de coalhada com manga."}}'),
  -- Fresh Lemon Soda
  ('20000000-0000-4000-8000-000000000021'::uuid, '{"ne": {"name": "फ्रेस लेमन सोडा", "description": "गुलियो, नुनिलो वा मिक्स।", "pronunciation": "fresh leman soda"}, "zh": {"name": "鲜柠檬苏打", "description": "甜味、咸味或甜咸混合。"}, "ja": {"name": "フレッシュレモンソーダ", "description": "甘め、塩味、またはミックスで。"}, "ko": {"name": "생레몬 소다", "description": "달게, 짭짤하게, 또는 반반."}, "pt": {"name": "Soda de Limão Fresco", "description": "Doce, salgada ou mista."}}')
) as v (id, t) where i.id = v.id;

update public.menu_variants mv set translations = v.t::jsonb from (values
  ('Large', '{"ne": {"label": "ठूलो"}, "zh": {"label": "大杯"}, "ja": {"label": "ラージ"}, "ko": {"label": "라지"}, "pt": {"label": "Grande"}}'),
  ('Oat milk', '{"ne": {"label": "ओट मिल्क"}, "zh": {"label": "燕麦奶"}, "ja": {"label": "オーツミルク"}, "ko": {"label": "오트밀크"}, "pt": {"label": "Leite de aveia"}}'),
  ('Iced', '{"ne": {"label": "आइस्ड"}, "zh": {"label": "冰饮"}, "ja": {"label": "アイス"}, "ko": {"label": "아이스"}, "pt": {"label": "Gelado"}}'),
  ('Extra achar', '{"ne": {"label": "थप अचार"}, "zh": {"label": "加阿查酱"}, "ja": {"label": "アチャール追加"}, "ko": {"label": "아차르 추가"}, "pt": {"label": "Achar extra"}}')
) as v (label, t) where mv.label = v.label and mv.item_id::text like '20000000-%';

-- Fail the seed loudly if a placeholder row was left without translations (e.g. an English name changed above).
do $$
begin
  if exists (select 1 from public.menu_categories where translations = '{}' and id::text like '10000000-%')
     or exists (select 1 from public.menu_items where translations = '{}' and id::text like '20000000-%')
     or exists (select 1 from public.menu_variants where translations = '{}' and item_id::text like '20000000-%') then
    raise exception 'seed: a placeholder menu row has no translations; update the translations block in seed.sql';
  end if;
end
$$;

insert into public.menu_specials (item_id, title, note, ends_at) values
  ('20000000-0000-4000-8000-000000000017', 'Placeholder special: Sel Roti morning', 'Demo data, not a real offer.', now() + interval '30 days');

-- Shop products (4, placeholder) ---------------------------------------------------------------------------
insert into public.products (id, slug, name, description, price_paisa, is_published, details) values
  ('30000000-0000-4000-8000-000000000001', 'nailed-classic-tee', 'Nailed Classic Tee (placeholder)',
   'Placeholder product. Soft cotton tee with a small chest print.', 120000, true,
   '{"fabric": "100% cotton (placeholder)", "gsm": 180, "printMethod": "placeholder", "credit": "placeholder",
     "sizeChartCm": {"S": {"chest": 96, "length": 69}, "M": {"chest": 102, "length": 71}, "L": {"chest": 108, "length": 73}, "XL": {"chest": 114, "length": 75}}}'),
  ('30000000-0000-4000-8000-000000000002', 'nailed-hoodie', 'Nailed Hoodie (placeholder)',
   'Placeholder product. Heavy fleece hoodie.', 280000, true,
   '{"fabric": "cotton fleece (placeholder)", "gsm": 320, "printMethod": "placeholder"}'),
  ('30000000-0000-4000-8000-000000000003', 'nailed-tote-bag', 'Nailed Tote Bag (placeholder)',
   'Placeholder product. Canvas tote.', 90000, true,
   '{"fabric": "canvas (placeholder)", "printMethod": "placeholder"}'),
  ('30000000-0000-4000-8000-000000000004', 'nailed-cap', 'Nailed Cap (placeholder)',
   'Placeholder product. Adjustable cap.', 70000, true,
   '{"fabric": "cotton twill (placeholder)", "printMethod": "placeholder"}');

insert into public.product_variants (id, product_id, size, colour, sku, stock, price_override_paisa) values
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'S',  'Black', 'TEE-BLK-S',  10, null),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'M',  'Black', 'TEE-BLK-M',  12, null),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 'L',  'Black', 'TEE-BLK-L',   8, null),
  ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000001', 'XL', 'Black', 'TEE-BLK-XL',  2, null),   -- few_left
  ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001', 'M',  'Cream', 'TEE-CRM-M',   6, null),
  ('40000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000001', 'L',  'Cream', 'TEE-CRM-L',   0, null),   -- sold_out
  ('40000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000002', 'M',  'Black', 'HOOD-BLK-M',  5, null),
  ('40000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000002', 'L',  'Black', 'HOOD-BLK-L',  5, null),
  ('40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000002', 'XL', 'Black', 'HOOD-BLK-XL', 4, 300000),  -- price override
  ('40000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000003', 'One size', 'Natural', 'TOTE-NAT', 20, null),
  ('40000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000004', 'Free size', 'Black',  'CAP-BLK',  15, null),
  ('40000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000004', 'Free size', 'Olive',  'CAP-OLV',   3, null);

-- Two sample orders through the real function (so seed data cannot drift from the rules) --------------------
-- #1 stays "placed" (pickup). #2 is delivery COD and is then cancelled by the customer to show the restock path.
do $$
declare
  r record;
begin
  select * into r from public.create_order(
    '[{"variantId": "40000000-0000-4000-8000-000000000002", "qty": 1}, {"variantId": "40000000-0000-4000-8000-000000000010", "qty": 1}]'::jsonb,
    'pickup', 'pickup', 'Demo Customer One', '+9779800000001', null, null, null, null,
    'Demo order (placeholder).', encode(sha256('seed-ip-1'::bytea), 'hex'));

  select * into r from public.create_order(
    '[{"variantId": "40000000-0000-4000-8000-000000000008", "qty": 1}]'::jsonb,
    'delivery', 'cod', 'Demo Customer Two', '+9779800000002', null, 'Demo Street 1', 'Near demo chowk', 'Thamel',
    'Demo order (placeholder).', encode(sha256('seed-ip-2'::bytea), 'hex'));
  perform public.customer_cancel_order(r.out_order_token);
end
$$;

-- Demo food sales log: 60 days (migration 20261025000001) ------------------------------------------------
-- ############################################################################################
-- #  DEMO DATA, PLACEHOLDER. Invented daily item counts so the owner statistics dashboard     #
-- #  has something to show locally. NOT the cafe's real sales. Every demo day has             #
-- #  note = 'DEMO DATA'. Remove it all (lines cascade) with:                                  #
-- #    delete from public.daily_sales where note = 'DEMO DATA';                               #
-- ############################################################################################
-- Days: the 60 Kathmandu dates before today (today is left empty for staff to log). Saturdays (closed in the
-- placeholder hours) and the placeholder closure dates in site_settings.hours are skipped. Pattern: Friday busiest,
-- Monday/Tuesday quietest, a slight upward trend, +/-25% deterministic noise (same numbers on every run for the
-- same date). Masala Chai is the bestseller by qty, Steam Chicken Momo by revenue; momo as a category leads.
-- Prices are snapshotted from the menu by the daily_sales_lines trigger (never written here).
-- Idempotent: a date that already has a log is left alone. Lines with qty 0 are not written.
do $$
declare
  v_today    date := (now() at time zone 'Asia/Kathmandu')::date;
  v_closures date[];
  v_day      date;
  v_g        integer;
  v_dow      integer;
  v_mult     numeric;
  v_id       uuid;
  v_sum      bigint;
begin
  select coalesce(array_agg((c ->> 'date')::date), '{}')
    into v_closures
    from public.site_settings s, jsonb_array_elements(coalesce(s.hours -> 'closures', '[]'::jsonb)) c;

  for v_g in 1 .. 60 loop
    v_day := v_today - v_g;
    v_dow := extract(dow from v_day)::integer;
    continue when v_dow = 6 or v_day = any (v_closures);

    insert into public.daily_sales (business_date, note)
    values (v_day, 'DEMO DATA')
    on conflict (business_date) do nothing
    returning id into v_id;
    continue when v_id is null;

    v_mult := (case v_dow when 0 then 1.00 when 1 then 0.82 when 2 then 0.85 when 3 then 0.92
                          when 4 then 0.97 when 5 then 1.30 else 1.00 end)
              * (0.94 + 0.12 * (60 - v_g) / 60.0);                               -- slow growth over the 60 days

    insert into public.daily_sales_lines (daily_sales_id, menu_item_id, variant_id, qty)
    select v_id, b.item_id, mv.id, q.qty
      from (values
        -- item id,                                 variant label, avg qty on a normal day
        ('20000000-0000-4000-8000-000000000001'::uuid, null::text,   6),   -- Espresso
        ('20000000-0000-4000-8000-000000000002'::uuid, null,         9),   -- Americano
        ('20000000-0000-4000-8000-000000000002'::uuid, 'Large',      3),
        ('20000000-0000-4000-8000-000000000003'::uuid, null,        14),   -- Cappuccino
        ('20000000-0000-4000-8000-000000000003'::uuid, 'Large',      5),
        ('20000000-0000-4000-8000-000000000004'::uuid, null,        10),   -- Cafe Latte
        ('20000000-0000-4000-8000-000000000004'::uuid, 'Iced',       5),
        ('20000000-0000-4000-8000-000000000004'::uuid, 'Oat milk',   2),
        ('20000000-0000-4000-8000-000000000005'::uuid, null,         7),   -- Iced Coffee
        ('20000000-0000-4000-8000-000000000006'::uuid, null,        48),   -- Masala Chai (bestseller, qty)
        ('20000000-0000-4000-8000-000000000006'::uuid, 'Large',     10),
        ('20000000-0000-4000-8000-000000000007'::uuid, null,        11),   -- Lemon Tea
        ('20000000-0000-4000-8000-000000000008'::uuid, null,         3),   -- Himalayan Green Tea
        ('20000000-0000-4000-8000-000000000009'::uuid, null,        30),   -- Steam Chicken Momo (bestseller, revenue)
        ('20000000-0000-4000-8000-000000000009'::uuid, 'Extra achar', 6),
        ('20000000-0000-4000-8000-000000000010'::uuid, null,        14),   -- Veg Momo
        ('20000000-0000-4000-8000-000000000011'::uuid, null,        18),   -- Buff Momo
        ('20000000-0000-4000-8000-000000000012'::uuid, null,        16),   -- Jhol Momo
        ('20000000-0000-4000-8000-000000000013'::uuid, null,        10),   -- Chicken Chowmein
        ('20000000-0000-4000-8000-000000000014'::uuid, null,         9),   -- French Fries
        ('20000000-0000-4000-8000-000000000015'::uuid, null,         7),   -- Aloo Paratha
        ('20000000-0000-4000-8000-000000000016'::uuid, null,         6),   -- Egg Sandwich
        ('20000000-0000-4000-8000-000000000017'::uuid, null,         5),   -- Sel Roti with Aloo Tarkari
        ('20000000-0000-4000-8000-000000000018'::uuid, null,         6),   -- Chocolate Brownie
        ('20000000-0000-4000-8000-000000000019'::uuid, null,         5),   -- Gulab Jamun
        ('20000000-0000-4000-8000-000000000020'::uuid, null,         9),   -- Mango Lassi
        ('20000000-0000-4000-8000-000000000021'::uuid, null,         8)    -- Fresh Lemon Soda
      ) as b (item_id, variant_label, base)
      join public.menu_items mi on mi.id = b.item_id                                   -- skip items that no longer exist
      left join public.menu_variants mv on mv.item_id = b.item_id and mv.label = b.variant_label
      cross join lateral (
        select greatest(0, round(b.base * v_mult
                 * (0.75 + 0.5 * (abs(hashtext(v_day::text || b.item_id::text || coalesce(b.variant_label, ''))) % 1000) / 1000.0)
               ))::integer as qty
      ) q
     where (b.variant_label is null or mv.id is not null)                              -- skip variants that no longer exist
       and q.qty > 0;

    -- Till total on about 6 of 7 days: lines total -1%..+3% (rounding, small extras), rounded to Rs. 10.
    select coalesce(sum(l.line_total_paisa), 0) into v_sum from public.daily_sales_lines l where l.daily_sales_id = v_id;
    update public.daily_sales d
       set till_total_paisa = case when abs(hashtext('till' || v_day::text)) % 7 = 0 then null
                                   else (round(v_sum * (0.99 + 0.04 * (abs(hashtext('tillv' || v_day::text)) % 100) / 100.0) / 1000) * 1000)::integer
                              end
     where d.id = v_id;
  end loop;
end
$$;

-- Table ordering (migrations 20261026000001..2, data-model decision 22) -------------------------------------------
-- PLACEHOLDER: 8 tables numbered 1..8, no labels (the real count comes from the client). Table ordering is switched
-- 'on' HERE ONLY so frontend and QA can work locally; the migration default stays 'off'. NO sessions are seeded on
-- purpose: a known join code on staging would be a free pass. Open a table from the board (or open_table_session).
-- The write guard only lets the table functions write these tables, so the seed sets the same transaction-local flag
-- the functions use (inside one DO block = one transaction).
do $$
begin
  perform set_config('app.table_write', 'on', true);
  insert into public.cafe_tables (number, label)
  select n, null from generate_series(1, 8) as n
   where not exists (select 1 from public.cafe_tables t where t.number = n);   -- deferrable key: no ON CONFLICT
  update public.site_settings set table_ordering = 'on';
  update public.table_board_state set version = version + 1, changed_at = now();
  perform set_config('app.table_write', 'off', true);
end
$$;
