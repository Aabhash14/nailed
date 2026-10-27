// HAND-UPDATED 2026-10-25 for migrations 20261026000001..2 (table ordering, decision 22, api-contract 2.2.0) in the
// generator's format, because those migrations are not yet applied to the local DB that `supabase gen types` reads.
// Regenerate (README "Types") after `supabase migration up --local`; the result should match this file.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      admin_alerts: {
        Row: {
          created_at: string;
          data: NonNullable<Json>;
          id: string;
          kind: string;
          read_at: string | null;
          read_by: string | null;
          session_id: string | null;
          text: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          data?: NonNullable<Json>;
          id?: string;
          kind: string;
          read_at?: string | null;
          read_by?: string | null;
          session_id?: string | null;
          text: string;
        };
        Update: {
          created_at?: string;
          data?: NonNullable<Json>;
          id?: string;
          kind?: string;
          read_at?: string | null;
          read_by?: string | null;
          session_id?: string | null;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "admin_alerts_read_by_fkey";
            columns: ["read_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "admin_alerts_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "table_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      alert_deliveries: {
        Row: {
          alert_id: string;
          attempts: number;
          channel: string;
          claimed_at: string;
          last_error: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          alert_id: string;
          attempts?: number;
          channel: string;
          claimed_at?: string;
          last_error?: string | null;
          status: string;
          updated_at?: string;
        };
        Update: {
          alert_id?: string;
          attempts?: number;
          channel?: string;
          claimed_at?: string;
          last_error?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "alert_deliveries_alert_id_fkey";
            columns: ["alert_id"];
            isOneToOne: false;
            referencedRelation: "admin_alerts";
            referencedColumns: ["id"];
          },
        ];
      };
      blocked_contacts: {
        Row: {
          created_at: string;
          created_by: string | null;
          expires_at: string;
          id: string;
          kind: string;
          reason: string | null;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          id?: string;
          kind: string;
          reason?: string | null;
          value: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          id?: string;
          kind?: string;
          reason?: string | null;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "blocked_contacts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      cafe_tables: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          label: string | null;
          number: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          label?: string | null;
          number: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          label?: string | null;
          number?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      daily_sales: {
        Row: {
          business_date: string;
          created_at: string;
          created_by: string | null;
          id: string;
          note: string | null;
          till_total_paisa: number | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          business_date: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          note?: string | null;
          till_total_paisa?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          business_date?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          note?: string | null;
          till_total_paisa?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "daily_sales_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "daily_sales_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      daily_sales_lines: {
        Row: {
          created_at: string;
          daily_sales_id: string;
          id: string;
          line_total_paisa: number | null;
          menu_item_id: string | null;
          menu_item_ref: string;
          name_snapshot: string;
          qty: number;
          unit_price_paisa: number;
          updated_at: string;
          updated_by: string | null;
          variant_id: string | null;
          variant_label_snapshot: string | null;
          variant_ref: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          daily_sales_id: string;
          id?: string;
          line_total_paisa?: never;
          menu_item_id?: string | null;
          menu_item_ref: string;
          name_snapshot: string;
          qty: number;
          unit_price_paisa: number;
          updated_at?: string;
          updated_by?: string | null;
          variant_id?: string | null;
          variant_label_snapshot?: string | null;
          variant_ref?: string | null;
        };
        Update: {
          created_at?: string;
          daily_sales_id?: string;
          id?: string;
          line_total_paisa?: never;
          menu_item_id?: string | null;
          menu_item_ref?: string;
          name_snapshot?: string;
          qty?: number;
          unit_price_paisa?: number;
          updated_at?: string;
          updated_by?: string | null;
          variant_id?: string | null;
          variant_label_snapshot?: string | null;
          variant_ref?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "daily_sales_lines_daily_sales_id_fkey";
            columns: ["daily_sales_id"];
            isOneToOne: false;
            referencedRelation: "daily_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "daily_sales_lines_menu_item_id_fkey";
            columns: ["menu_item_id"];
            isOneToOne: false;
            referencedRelation: "menu_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "daily_sales_lines_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "daily_sales_lines_variant_id_fkey";
            columns: ["variant_id"];
            isOneToOne: false;
            referencedRelation: "menu_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      menu_categories: {
        Row: {
          created_at: string;
          id: string;
          is_visible: boolean;
          name: string;
          slug: string;
          sort_order: number;
          translations: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          is_visible?: boolean;
          name: string;
          slug: string;
          sort_order?: number;
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_visible?: boolean;
          name?: string;
          slug?: string;
          sort_order?: number;
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [];
      };
      menu_items: {
        Row: {
          category_id: string;
          created_at: string;
          deleted_at: string | null;
          description: string | null;
          diet: string;
          id: string;
          image_path: string | null;
          is_sold_out: boolean;
          is_visible: boolean;
          name: string;
          price_paisa: number;
          sort_order: number;
          tags: string[];
          translations: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          category_id: string;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          diet?: string;
          id?: string;
          image_path?: string | null;
          is_sold_out?: boolean;
          is_visible?: boolean;
          name: string;
          price_paisa: number;
          sort_order?: number;
          tags?: string[];
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          category_id?: string;
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          diet?: string;
          id?: string;
          image_path?: string | null;
          is_sold_out?: boolean;
          is_visible?: boolean;
          name?: string;
          price_paisa?: number;
          sort_order?: number;
          tags?: string[];
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "menu_items_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "menu_categories";
            referencedColumns: ["id"];
          },
        ];
      };
      menu_specials: {
        Row: {
          created_at: string;
          ends_at: string | null;
          id: string;
          item_id: string | null;
          note: string | null;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          ends_at?: string | null;
          id?: string;
          item_id?: string | null;
          note?: string | null;
          title: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          ends_at?: string | null;
          id?: string;
          item_id?: string | null;
          note?: string | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "menu_specials_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "menu_items";
            referencedColumns: ["id"];
          },
        ];
      };
      menu_variants: {
        Row: {
          created_at: string;
          id: string;
          is_sold_out: boolean;
          item_id: string;
          kind: string;
          label: string;
          price_delta_paisa: number;
          sort_order: number;
          translations: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          is_sold_out?: boolean;
          item_id: string;
          kind: string;
          label: string;
          price_delta_paisa?: number;
          sort_order?: number;
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_sold_out?: boolean;
          item_id?: string;
          kind?: string;
          label?: string;
          price_delta_paisa?: number;
          sort_order?: number;
          translations?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "menu_variants_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "menu_items";
            referencedColumns: ["id"];
          },
        ];
      };
      order_items: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          order_id: string;
          product_variant_id: string;
          qty: number;
          unit_price_paisa: number;
          variant_label: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          order_id: string;
          product_variant_id: string;
          qty: number;
          unit_price_paisa: number;
          variant_label: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          order_id?: string;
          product_variant_id?: string;
          qty?: number;
          unit_price_paisa?: number;
          variant_label?: string;
        };
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "order_items_product_variant_id_fkey";
            columns: ["product_variant_id"];
            isOneToOne: false;
            referencedRelation: "product_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      order_rules: {
        Row: {
          auto_cancel_placed_after_minutes: number | null;
          blocklist_months: number;
          cod_max_total_paisa: number | null;
          created_at: string;
          id: boolean;
          ip_open_orders_max: number;
          ip_orders_max: number;
          ip_orders_max_per_day: number;
          ip_window_minutes: number;
          max_open_orders_per_phone: number;
          owner_alert_whatsapp: string[];
          phone_orders_max_per_day: number;
          retention_days: number;
          staff_cancel_window_minutes: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          auto_cancel_placed_after_minutes?: number | null;
          blocklist_months?: number;
          cod_max_total_paisa?: number | null;
          created_at?: string;
          id?: boolean;
          ip_open_orders_max?: number;
          ip_orders_max?: number;
          ip_orders_max_per_day?: number;
          ip_window_minutes?: number;
          max_open_orders_per_phone?: number;
          owner_alert_whatsapp?: string[];
          phone_orders_max_per_day?: number;
          retention_days?: number;
          staff_cancel_window_minutes?: number;
          updated_at?: string;
        };
        Update: {
          auto_cancel_placed_after_minutes?: number | null;
          blocklist_months?: number;
          cod_max_total_paisa?: number | null;
          created_at?: string;
          id?: boolean;
          ip_open_orders_max?: number;
          ip_orders_max?: number;
          ip_orders_max_per_day?: number;
          ip_window_minutes?: number;
          max_open_orders_per_phone?: number;
          owner_alert_whatsapp?: string[];
          phone_orders_max_per_day?: number;
          retention_days?: number;
          staff_cancel_window_minutes?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      orders: {
        Row: {
          address: string | null;
          area: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          delivery_fee_paisa: number;
          fulfilment: string;
          id: string;
          ip_hash: string | null;
          landmark: string | null;
          notes: string | null;
          number: string;
          payment_method: string;
          payment_status: string;
          personal_data_purged_at: string | null;
          prices_include_vat: boolean;
          public_token: string;
          service_charge_paisa: number;
          status: string;
          stock_restocked_at: string | null;
          subtotal_paisa: number;
          total_paisa: number;
          updated_at: string;
          vat_paisa: number;
        };
        ComputedFields: never;
        Insert: {
          address?: string | null;
          area?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          delivery_fee_paisa?: number;
          fulfilment: string;
          id?: string;
          ip_hash?: string | null;
          landmark?: string | null;
          notes?: string | null;
          number?: string;
          payment_method: string;
          payment_status?: string;
          personal_data_purged_at?: string | null;
          prices_include_vat: boolean;
          public_token?: string;
          service_charge_paisa?: number;
          status?: string;
          stock_restocked_at?: string | null;
          subtotal_paisa: number;
          total_paisa: number;
          updated_at?: string;
          vat_paisa?: number;
        };
        Update: {
          address?: string | null;
          area?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          delivery_fee_paisa?: number;
          fulfilment?: string;
          id?: string;
          ip_hash?: string | null;
          landmark?: string | null;
          notes?: string | null;
          number?: string;
          payment_method?: string;
          payment_status?: string;
          personal_data_purged_at?: string | null;
          prices_include_vat?: boolean;
          public_token?: string;
          service_charge_paisa?: number;
          status?: string;
          stock_restocked_at?: string | null;
          subtotal_paisa?: number;
          total_paisa?: number;
          updated_at?: string;
          vat_paisa?: number;
        };
        Relationships: [];
      };
      product_images: {
        Row: {
          alt: string;
          created_at: string;
          id: string;
          path: string;
          product_id: string;
          sort_order: number;
        };
        ComputedFields: never;
        Insert: {
          alt?: string;
          created_at?: string;
          id?: string;
          path: string;
          product_id: string;
          sort_order?: number;
        };
        Update: {
          alt?: string;
          created_at?: string;
          id?: string;
          path?: string;
          product_id?: string;
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: "product_images_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      product_variants: {
        Row: {
          colour: string;
          created_at: string;
          id: string;
          price_override_paisa: number | null;
          product_id: string;
          size: string;
          size_rank: number | null;
          sku: string | null;
          stock: number;
          stock_state: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          colour: string;
          created_at?: string;
          id?: string;
          price_override_paisa?: number | null;
          product_id: string;
          size: string;
          size_rank?: never;
          sku?: string | null;
          stock?: number;
          stock_state?: never;
          updated_at?: string;
        };
        Update: {
          colour?: string;
          created_at?: string;
          id?: string;
          price_override_paisa?: number | null;
          product_id?: string;
          size?: string;
          size_rank?: never;
          sku?: string | null;
          stock?: number;
          stock_state?: never;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
        ];
      };
      products: {
        Row: {
          created_at: string;
          description: string | null;
          details: NonNullable<Json>;
          id: string;
          is_published: boolean;
          name: string;
          price_paisa: number;
          slug: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          details?: NonNullable<Json>;
          id?: string;
          is_published?: boolean;
          name: string;
          price_paisa: number;
          slug: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          details?: NonNullable<Json>;
          id?: string;
          is_published?: boolean;
          name?: string;
          price_paisa?: number;
          slug?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string;
          id: string;
          role: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          display_name: string;
          id: string;
          role: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          id?: string;
          role?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rate_limits: {
        Row: {
          count: number;
          key: string;
          window_start: string;
        };
        ComputedFields: never;
        Insert: {
          count?: number;
          key: string;
          window_start: string;
        };
        Update: {
          count?: number;
          key?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      site_settings: {
        Row: {
          address: string | null;
          announcement: string | null;
          cafe_name: string;
          created_at: string;
          delivery_areas: string[];
          delivery_fee_paisa: number;
          email: string | null;
          features: NonNullable<Json>;
          hours: NonNullable<Json>;
          id: boolean;
          landmark: string | null;
          map_url: string | null;
          min_order_delivery_paisa: number;
          min_order_pickup_paisa: number;
          orders_paused: boolean;
          payment_methods_enabled: string[];
          phone: string | null;
          prices_include_vat: boolean;
          service_charge_pct: number;
          table_ordering: string;
          updated_at: string;
          whatsapp: string | null;
        };
        ComputedFields: never;
        Insert: {
          address?: string | null;
          announcement?: string | null;
          cafe_name?: string;
          created_at?: string;
          delivery_areas?: string[];
          delivery_fee_paisa?: number;
          email?: string | null;
          features?: NonNullable<Json>;
          hours?: NonNullable<Json>;
          id?: boolean;
          landmark?: string | null;
          map_url?: string | null;
          min_order_delivery_paisa?: number;
          min_order_pickup_paisa?: number;
          orders_paused?: boolean;
          payment_methods_enabled?: string[];
          phone?: string | null;
          prices_include_vat?: boolean;
          service_charge_pct?: number;
          table_ordering?: string;
          updated_at?: string;
          whatsapp?: string | null;
        };
        Update: {
          address?: string | null;
          announcement?: string | null;
          cafe_name?: string;
          created_at?: string;
          delivery_areas?: string[];
          delivery_fee_paisa?: number;
          email?: string | null;
          features?: NonNullable<Json>;
          hours?: NonNullable<Json>;
          id?: boolean;
          landmark?: string | null;
          map_url?: string | null;
          min_order_delivery_paisa?: number;
          min_order_pickup_paisa?: number;
          orders_paused?: boolean;
          payment_methods_enabled?: string[];
          phone?: string | null;
          prices_include_vat?: boolean;
          service_charge_pct?: number;
          table_ordering?: string;
          updated_at?: string;
          whatsapp?: string | null;
        };
        Relationships: [];
      };
      table_board_state: {
        Row: {
          changed_at: string;
          id: boolean;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          changed_at?: string;
          id?: boolean;
          version?: number;
        };
        Update: {
          changed_at?: string;
          id?: boolean;
          version?: number;
        };
        Relationships: [];
      };
      table_order_items: {
        Row: {
          id: string;
          line_no: number;
          line_total_paisa: number | null;
          menu_item_ref: string;
          name_snapshot: string;
          options_snapshot: string | null;
          order_id: string;
          qty: number;
          unit_price_paisa: number;
          variant_refs: string[];
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          line_no: number;
          line_total_paisa?: never;
          menu_item_ref: string;
          name_snapshot: string;
          options_snapshot?: string | null;
          order_id: string;
          qty: number;
          unit_price_paisa: number;
          variant_refs?: string[];
        };
        Update: {
          id?: string;
          line_no?: number;
          line_total_paisa?: never;
          menu_item_ref?: string;
          name_snapshot?: string;
          options_snapshot?: string | null;
          order_id?: string;
          qty?: number;
          unit_price_paisa?: number;
          variant_refs?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "table_order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "table_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      table_orders: {
        Row: {
          accepted_at: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          client_request_id: string;
          created_at: string;
          id: string;
          note: string | null;
          request_fingerprint: string;
          round: number;
          served_at: string | null;
          session_id: string;
          status: string;
          subtotal_paisa: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          client_request_id: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          request_fingerprint: string;
          round: number;
          served_at?: string | null;
          session_id: string;
          status?: string;
          subtotal_paisa: number;
          updated_at?: string;
        };
        Update: {
          accepted_at?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          client_request_id?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          request_fingerprint?: string;
          round?: number;
          served_at?: string | null;
          session_id?: string;
          status?: string;
          subtotal_paisa?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "table_orders_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "table_orders_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "table_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      table_sessions: {
        Row: {
          closed_at: string | null;
          closed_by: string | null;
          code: string | null;
          cookie_epoch: number;
          id: string;
          opened_at: string;
          opened_by: string | null;
          orders_locked: boolean;
          outcome: string | null;
          paid_via: string | null;
          prices_include_vat: boolean | null;
          rev: number;
          service_charge_paisa: number | null;
          status: string;
          subtotal_paisa: number | null;
          table_id: string;
          table_number: number;
          total_paisa: number | null;
          updated_at: string;
          vat_paisa: number | null;
        };
        ComputedFields: never;
        Insert: {
          closed_at?: string | null;
          closed_by?: string | null;
          code?: string | null;
          cookie_epoch?: number;
          id?: string;
          opened_at?: string;
          opened_by?: string | null;
          orders_locked?: boolean;
          outcome?: string | null;
          paid_via?: string | null;
          prices_include_vat?: boolean | null;
          rev?: number;
          service_charge_paisa?: number | null;
          status?: string;
          subtotal_paisa?: number | null;
          table_id: string;
          table_number: number;
          total_paisa?: number | null;
          updated_at?: string;
          vat_paisa?: number | null;
        };
        Update: {
          closed_at?: string | null;
          closed_by?: string | null;
          code?: string | null;
          cookie_epoch?: number;
          id?: string;
          opened_at?: string;
          opened_by?: string | null;
          orders_locked?: boolean;
          outcome?: string | null;
          paid_via?: string | null;
          prices_include_vat?: boolean | null;
          rev?: number;
          service_charge_paisa?: number | null;
          status?: string;
          subtotal_paisa?: number | null;
          table_id?: string;
          table_number?: number;
          total_paisa?: number | null;
          updated_at?: string;
          vat_paisa?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "table_sessions_closed_by_fkey";
            columns: ["closed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "table_sessions_opened_by_fkey";
            columns: ["opened_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "table_sessions_table_id_fkey";
            columns: ["table_id"];
            isOneToOne: false;
            referencedRelation: "cafe_tables";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      public_settings: {
        Row: {
          address: string | null;
          announcement: string | null;
          cafe_name: string | null;
          delivery_areas: string[] | null;
          delivery_fee_paisa: number | null;
          email: string | null;
          features: Json | null;
          hours: Json | null;
          landmark: string | null;
          map_url: string | null;
          min_order_delivery_paisa: number | null;
          min_order_pickup_paisa: number | null;
          orders_paused: boolean | null;
          payment_methods_enabled: string[] | null;
          phone: string | null;
          prices_include_vat: boolean | null;
          service_charge_pct: number | null;
          table_ordering: string | null;
          updated_at: string | null;
          vat_pct: number | null;
          whatsapp: string | null;
        };
        ComputedFields: never;
        Insert: {
          address?: string | null;
          announcement?: string | null;
          cafe_name?: string | null;
          delivery_areas?: string[] | null;
          delivery_fee_paisa?: number | null;
          email?: string | null;
          features?: Json | null;
          hours?: Json | null;
          landmark?: string | null;
          map_url?: string | null;
          min_order_delivery_paisa?: number | null;
          min_order_pickup_paisa?: number | null;
          orders_paused?: boolean | null;
          payment_methods_enabled?: string[] | null;
          phone?: string | null;
          prices_include_vat?: boolean | null;
          service_charge_pct?: number | null;
          table_ordering?: string | null;
          updated_at?: string | null;
          vat_pct?: never;
          whatsapp?: string | null;
        };
        Update: {
          address?: string | null;
          announcement?: string | null;
          cafe_name?: string | null;
          delivery_areas?: string[] | null;
          delivery_fee_paisa?: number | null;
          email?: string | null;
          features?: Json | null;
          hours?: Json | null;
          landmark?: string | null;
          map_url?: string | null;
          min_order_delivery_paisa?: number | null;
          min_order_pickup_paisa?: number | null;
          orders_paused?: boolean | null;
          payment_methods_enabled?: string[] | null;
          phone?: string | null;
          prices_include_vat?: boolean | null;
          service_charge_pct?: number | null;
          table_ordering?: string | null;
          updated_at?: string | null;
          vat_pct?: never;
          whatsapp?: string | null;
        };
        Relationships: [];
      };
      table_occupancy: {
        Row: {
          label: string | null;
          number: number | null;
          occupied: boolean | null;
        };
        ComputedFields: never;
        Insert: {
          label?: string | null;
          number?: number | null;
          occupied?: never;
        };
        Update: {
          label?: string | null;
          number?: number | null;
          occupied?: never;
        };
        Relationships: [];
      };
    };
    Functions: {
      auto_cancel_unconfirmed_orders: { Args: Record<PropertyKey, never>; Returns: Json };
      auto_close_stale_table_sessions: { Args: Record<PropertyKey, never>; Returns: Json };
      block_contact: {
        Args: { p_actor: string; p_kind: string; p_reason: string; p_value: string };
        Returns: {
          out_created: boolean;
          out_expires_at: string;
          out_id: string;
        }[];
      };
      cancel_order: {
        Args: {
          p_actor: string;
          p_block_contact?: boolean;
          p_order_id: string;
          p_reason: string;
          p_restock: boolean;
        };
        Returns: {
          address: string | null;
          area: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          delivery_fee_paisa: number;
          fulfilment: string;
          id: string;
          ip_hash: string | null;
          landmark: string | null;
          notes: string | null;
          number: string;
          payment_method: string;
          payment_status: string;
          personal_data_purged_at: string | null;
          prices_include_vat: boolean;
          public_token: string;
          service_charge_paisa: number;
          status: string;
          stock_restocked_at: string | null;
          subtotal_paisa: number;
          total_paisa: number;
          updated_at: string;
          vat_paisa: number;
        };
        SetofOptions: {
          from: "*";
          to: "orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      claim_alert_deliveries: { Args: { p_channel: string; p_limit: number }; Returns: Json[] };
      close_table_session: {
        Args: {
          p_actor: string;
          p_expected_total: number;
          p_outcome: string;
          p_paid_via: string;
          p_session_id: string;
        };
        Returns: Json;
      };
      create_order: {
        Args: {
          p_address?: string;
          p_area?: string;
          p_customer_email?: string;
          p_customer_name: string;
          p_customer_phone: string;
          p_fulfilment: string;
          p_ip_hash?: string;
          p_items: Json;
          p_landmark?: string;
          p_notes?: string;
          p_payment_method: string;
        };
        Returns: {
          out_order_id: string;
          out_order_number: string;
          out_order_token: string;
          out_status: string;
          out_total_paisa: number;
        }[];
      };
      create_table_order: {
        Args: {
          p_client_request_id: string;
          p_epoch: number;
          p_items: Json;
          p_note?: string;
          p_session_id: string;
        };
        Returns: Json;
      };
      current_app_role: { Args: Record<PropertyKey, never>; Returns: string };
      customer_cancel_order: {
        Args: { p_token: string };
        Returns: {
          address: string | null;
          area: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          delivery_fee_paisa: number;
          fulfilment: string;
          id: string;
          ip_hash: string | null;
          landmark: string | null;
          notes: string | null;
          number: string;
          payment_method: string;
          payment_status: string;
          personal_data_purged_at: string | null;
          prices_include_vat: boolean;
          public_token: string;
          service_charge_paisa: number;
          status: string;
          stock_restocked_at: string | null;
          subtotal_paisa: number;
          total_paisa: number;
          updated_at: string;
          vat_paisa: number;
        };
        SetofOptions: {
          from: "*";
          to: "orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      finish_alert_delivery: {
        Args: { p_alert_id: string; p_channel: string; p_error: string; p_ok: boolean };
        Returns: undefined;
      };
      get_daily_sales: { Args: { p_actor?: string; p_date: string }; Returns: Json };
      health_ping: { Args: Record<PropertyKey, never>; Returns: string };
      is_owner: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_staff: { Args: Record<PropertyKey, never>; Returns: boolean };
      join_table_session: { Args: { p_code: string; p_table_number: number }; Returns: Json };
      list_cafe_tables: { Args: { p_actor: string }; Returns: Json };
      mark_admin_alerts_read: {
        Args: { p_actor: string; p_all: boolean; p_ids: string[] };
        Returns: number;
      };
      open_table_session: { Args: { p_actor: string; p_table_id: string }; Returns: Json };
      purge_personal_data: { Args: Record<PropertyKey, never>; Returns: Json };
      rate_limit_hit: {
        Args: { p_key: string; p_max: number; p_window_seconds: number };
        Returns: boolean;
      };
      rate_limit_hit_info: {
        Args: { p_key: string; p_max: number; p_window_seconds: number };
        Returns: {
          allowed: boolean;
          remaining: number;
          retry_after_seconds: number;
        }[];
      };
      record_admin_alert: { Args: { p_data: Json; p_kind: string }; Returns: string };
      rotate_table_code: { Args: { p_actor: string; p_session_id: string }; Returns: Json };
      save_cafe_tables: { Args: { p_actor: string; p_tables: Json }; Returns: Json };
      set_order_status: {
        Args: {
          p_actor: string;
          p_block_contact?: boolean;
          p_order_id: string;
          p_reason?: string;
          p_restock?: boolean;
          p_status: string;
        };
        Returns: {
          address: string | null;
          area: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          delivery_fee_paisa: number;
          fulfilment: string;
          id: string;
          ip_hash: string | null;
          landmark: string | null;
          notes: string | null;
          number: string;
          payment_method: string;
          payment_status: string;
          personal_data_purged_at: string | null;
          prices_include_vat: boolean;
          public_token: string;
          service_charge_paisa: number;
          status: string;
          stock_restocked_at: string | null;
          subtotal_paisa: number;
          total_paisa: number;
          updated_at: string;
          vat_paisa: number;
        };
        SetofOptions: {
          from: "*";
          to: "orders";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_table_ordering: { Args: { p_actor: string; p_mode: string }; Returns: string };
      set_table_orders_locked: {
        Args: { p_actor: string; p_locked: boolean; p_session_id: string };
        Returns: Json;
      };
      stats_best_food_per_day: {
        Args: { p_actor?: string; p_from: string; p_to: string };
        Returns: Json;
      };
      stats_busy_heatmap: {
        Args: { p_actor?: string; p_from: string; p_to: string };
        Returns: Json;
      };
      stats_cancellations: {
        Args: { p_actor?: string; p_from: string; p_to: string };
        Returns: Json;
      };
      stats_overview: {
        Args: {
          p_actor?: string;
          p_cmp_from?: string;
          p_cmp_to?: string;
          p_from: string;
          p_to: string;
        };
        Returns: Json;
      };
      stats_stock_alerts: { Args: { p_actor?: string }; Returns: Json };
      stats_table_orders: {
        Args: { p_actor: string; p_from: string; p_to: string };
        Returns: Json;
      };
      stats_timeseries: {
        Args: { p_actor?: string; p_from: string; p_grain?: string; p_to: string };
        Returns: Json;
      };
      stats_top_food: {
        Args: { p_actor?: string; p_from: string; p_limit?: number; p_to: string };
        Returns: Json;
      };
      stats_top_merch: {
        Args: { p_actor?: string; p_from: string; p_limit?: number; p_to: string };
        Returns: Json;
      };
      table_board: { Args: { p_actor: string; p_since: string }; Returns: Json };
      table_session_guest_view: {
        Args: { p_epoch: number; p_session_id: string; p_since?: number };
        Returns: Json;
      };
      transition_table_order: {
        Args: { p_actor: string; p_order_id: string; p_reason: string; p_to: string };
        Returns: Json;
      };
      upsert_daily_sales: {
        Args: {
          p_actor?: string;
          p_date: string;
          p_lines: Json;
          p_note?: string;
          p_till_total?: number;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
