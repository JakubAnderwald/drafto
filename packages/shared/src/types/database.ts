export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          is_approved: boolean;
          is_admin: boolean;
          display_name: string | null;
          // Attachment storage quota in bytes; null = unlimited (issue #794).
          storage_quota_bytes: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          is_approved?: boolean;
          is_admin?: boolean;
          display_name?: string | null;
          storage_quota_bytes?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          is_approved?: boolean;
          is_admin?: boolean;
          display_name?: string | null;
          storage_quota_bytes?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notebooks: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notebooks_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notes: {
        Row: {
          id: string;
          notebook_id: string;
          user_id: string;
          title: string;
          content: Json | null;
          is_trashed: boolean;
          trashed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          notebook_id: string;
          user_id: string;
          title?: string;
          content?: Json | null;
          is_trashed?: boolean;
          trashed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          notebook_id?: string;
          user_id?: string;
          title?: string;
          content?: Json | null;
          is_trashed?: boolean;
          trashed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notes_notebook_id_fkey";
            columns: ["notebook_id"];
            isOneToOne: false;
            referencedRelation: "notebooks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      attachments: {
        Row: {
          id: string;
          note_id: string;
          user_id: string;
          file_name: string;
          file_path: string;
          file_size: number;
          mime_type: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          note_id: string;
          user_id: string;
          file_name: string;
          file_path: string;
          file_size: number;
          mime_type: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          note_id?: string;
          user_id?: string;
          file_name?: string;
          file_path?: string;
          file_size?: number;
          mime_type?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_note_id_fkey";
            columns: ["note_id"];
            isOneToOne: false;
            referencedRelation: "notes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "attachments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      api_keys: {
        Row: {
          id: string;
          user_id: string;
          key_prefix: string;
          key_hash: string;
          name: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          key_prefix: string;
          key_hash: string;
          name?: string;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          key_prefix?: string;
          key_hash?: string;
          name?: string;
          created_at?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "api_keys_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_server_time: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      // Service role only (pg_cron and the cron route).
      cleanup_trashed_notes: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      // Service role only: attachment object names whose note no longer exists.
      orphaned_attachment_objects: {
        Args: { max_rows?: number; only_user?: string | null };
        Returns: string[];
      };
      // The caller's attachment storage usage and quota (issue #794). One row.
      get_my_storage_usage: {
        Args: Record<PropertyKey, never>;
        Returns: {
          used_bytes: number;
          quota_bytes: number | null;
        }[];
      };
      // Every user's usage and quota; raises 42501 unless the caller is an admin.
      admin_storage_usage: {
        Args: Record<PropertyKey, never>;
        Returns: {
          user_id: string;
          used_bytes: number;
          quota_bytes: number | null;
        }[];
      };
      // Used by the attachments bucket's storage policies.
      can_store_attachment: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
  };
}
