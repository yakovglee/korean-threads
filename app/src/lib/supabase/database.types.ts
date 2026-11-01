
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "access_list": {
                  Row: {
                    "added_at": string,"email": string,"is_admin": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "added_at"?: string,"email": string,"is_admin"?: boolean
                  }
                  Update: {
                    "added_at"?: string,"email"?: string,"is_admin"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"answer_sources": {
                  Row: {
                    "answer_id": string,"label": string | null,"page": number | null,"position": number,"quote": string,"title": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_id": string,"label"?: string | null,"page"?: number | null,"position": number,"quote": string,"title": string,"user_id": string
                  }
                  Update: {
                    "answer_id"?: string,"label"?: string | null,"page"?: number | null,"position"?: number,"quote"?: string,"title"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "answer_sources_answer_id_fkey"
      columns: ["answer_id"]
isOneToOne: false
      referencedRelation: "answers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "answer_sources_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"answers": {
                  Row: {
                    "created_at": string,"general_knowledge": boolean,"id": string,"model": string,"off_topic": boolean,"thread_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"general_knowledge"?: boolean,"id"?: string,"model": string,"off_topic"?: boolean,"thread_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"general_knowledge"?: boolean,"id"?: string,"model"?: string,"off_topic"?: boolean,"thread_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "answers_thread_id_fkey"
      columns: ["thread_id"]
isOneToOne: false
      referencedRelation: "threads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "answers_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"app_settings": {
                  Row: {
                    "default_model": string | null,"id": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "default_model"?: string | null,"id"?: boolean
                  }
                  Update: {
                    "default_model"?: string | null,"id"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "app_settings_default_model_fkey"
      columns: ["default_model"]
isOneToOne: false
      referencedRelation: "models"
      referencedColumns: ["id"]
    }
                  ]
                },"attempts": {
                  Row: {
                    "choice": number | null,"correct": boolean | null,"created_at": string,"feedback": string | null,"id": string,"quiz_item_id": string,"sentence": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "choice"?: number | null,"correct"?: boolean | null,"created_at"?: string,"feedback"?: string | null,"id"?: string,"quiz_item_id": string,"sentence"?: string | null,"user_id": string
                  }
                  Update: {
                    "choice"?: number | null,"correct"?: boolean | null,"created_at"?: string,"feedback"?: string | null,"id"?: string,"quiz_item_id"?: string,"sentence"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attempts_quiz_item_id_fkey"
      columns: ["quiz_item_id"]
isOneToOne: false
      referencedRelation: "quiz_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attempts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"bookmarks": {
                  Row: {
                    "created_at": string,"post_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"post_id": string,"user_id"?: string
                  }
                  Update: {
                    "created_at"?: string,"post_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bookmarks_post_id_fkey"
      columns: ["post_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bookmarks_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"books": {
                  Row: {
                    "id": number,"slug": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: never,"slug": string,"title": string
                  }
                  Update: {
                    "id"?: never,"slug"?: string,"title"?: string
                  }
                  Relationships: [
                    
                  ]
                },"chunks": {
                  Row: {
                    "book_id": number,"construction_id": number | null,"content": string,"embedding": string,"id": number,"label": string | null,"page": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "book_id": number,"construction_id"?: number | null,"content": string,"embedding": string,"id"?: never,"label"?: string | null,"page"?: number | null
                  }
                  Update: {
                    "book_id"?: number,"construction_id"?: number | null,"content"?: string,"embedding"?: string,"id"?: never,"label"?: string | null,"page"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "chunks_book_id_fkey"
      columns: ["book_id"]
isOneToOne: false
      referencedRelation: "books"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chunks_construction_id_fkey"
      columns: ["construction_id"]
isOneToOne: false
      referencedRelation: "constructions"
      referencedColumns: ["id"]
    }
                  ]
                },"constructions": {
                  Row: {
                    "id": number,"key": string,"level": Database["public"]['Enums']["level"] | null,"meaning": string | null,"name": string,"pos": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: never,"key": string,"level"?: Database["public"]['Enums']["level"] | null,"meaning"?: string | null,"name": string,"pos"?: string | null
                  }
                  Update: {
                    "id"?: never,"key"?: string,"level"?: Database["public"]['Enums']["level"] | null,"meaning"?: string | null,"name"?: string,"pos"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"dict_cache": {
                  Row: {
                    "data": NonNullable<Json>,"fetched_at": string,"key": string
                  }
                  ComputedFields: never
                  Insert: {
                    "data": NonNullable<Json>,"fetched_at"?: string,"key": string
                  }
                  Update: {
                    "data"?: NonNullable<Json>,"fetched_at"?: string,"key"?: string
                  }
                  Relationships: [
                    
                  ]
                },"exams": {
                  Row: {
                    "id": number,"level": string,"session": number
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: never,"level": string,"session": number
                  }
                  Update: {
                    "id"?: never,"level"?: string,"session"?: number
                  }
                  Relationships: [
                    
                  ]
                },"models": {
                  Row: {
                    "enabled": boolean,"id": string,"label": string,"position": number
                  }
                  ComputedFields: never
                  Insert: {
                    "enabled"?: boolean,"id": string,"label": string,"position"?: number
                  }
                  Update: {
                    "enabled"?: boolean,"id"?: string,"label"?: string,"position"?: number
                  }
                  Relationships: [
                    
                  ]
                },"posts": {
                  Row: {
                    "answer_id": string | null,"author": string,"body": string,"created_at": string,"embedding": string | null,"id": string,"quote_post_id": string | null,"seq": number,"thread_id": string,"user_id": string,"words": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_id"?: string | null,"author": string,"body": string,"created_at"?: string,"embedding"?: string | null,"id"?: string,"quote_post_id"?: string | null,"seq"?: never,"thread_id": string,"user_id": string,"words"?: Json | null
                  }
                  Update: {
                    "answer_id"?: string | null,"author"?: string,"body"?: string,"created_at"?: string,"embedding"?: string | null,"id"?: string,"quote_post_id"?: string | null,"seq"?: never,"thread_id"?: string,"user_id"?: string,"words"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "posts_answer_id_fkey"
      columns: ["answer_id"]
isOneToOne: false
      referencedRelation: "answers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "posts_quote_post_id_fkey"
      columns: ["quote_post_id"]
isOneToOne: false
      referencedRelation: "posts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "posts_thread_id_fkey"
      columns: ["thread_id"]
isOneToOne: false
      referencedRelation: "threads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "posts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"email": string,"id": string,"level": Database["public"]['Enums']["level"] | null,"model": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email": string,"id": string,"level"?: Database["public"]['Enums']["level"] | null,"model"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"email"?: string,"id"?: string,"level"?: Database["public"]['Enums']["level"] | null,"model"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_model_fkey"
      columns: ["model"]
isOneToOne: false
      referencedRelation: "models"
      referencedColumns: ["id"]
    }
                  ]
                },"quiz_items": {
                  Row: {
                    "batch": number,"construction_id": number | null,"content": NonNullable<Json>,"created_at": string,"id": string,"kind": string,"position": number,"quiz_id": string,"solution": Json | null,"topik_task_id": number | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch"?: number,"construction_id"?: number | null,"content": NonNullable<Json>,"created_at"?: string,"id"?: string,"kind": string,"position": number,"quiz_id": string,"solution"?: Json | null,"topik_task_id"?: number | null,"user_id": string
                  }
                  Update: {
                    "batch"?: number,"construction_id"?: number | null,"content"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"kind"?: string,"position"?: number,"quiz_id"?: string,"solution"?: Json | null,"topik_task_id"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quiz_items_construction_id_fkey"
      columns: ["construction_id"]
isOneToOne: false
      referencedRelation: "constructions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_items_quiz_id_fkey"
      columns: ["quiz_id"]
isOneToOne: false
      referencedRelation: "quizzes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_items_topik_task_id_fkey"
      columns: ["topik_task_id"]
isOneToOne: false
      referencedRelation: "topik_tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_items_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"quizzes": {
                  Row: {
                    "created_at": string,"id": string,"thread_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"thread_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"thread_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quizzes_thread_id_fkey"
      columns: ["thread_id"]
isOneToOne: true
      referencedRelation: "threads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quizzes_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"thread_tags": {
                  Row: {
                    "construction_id": number | null,"id": number,"kind": string,"level": Database["public"]['Enums']["level"] | null,"thread_id": string,"user_id": string,"value": string
                  }
                  ComputedFields: never
                  Insert: {
                    "construction_id"?: number | null,"id"?: never,"kind": string,"level"?: Database["public"]['Enums']["level"] | null,"thread_id": string,"user_id": string,"value": string
                  }
                  Update: {
                    "construction_id"?: number | null,"id"?: never,"kind"?: string,"level"?: Database["public"]['Enums']["level"] | null,"thread_id"?: string,"user_id"?: string,"value"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "thread_tags_construction_id_fkey"
      columns: ["construction_id"]
isOneToOne: false
      referencedRelation: "constructions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "thread_tags_thread_id_fkey"
      columns: ["thread_id"]
isOneToOne: false
      referencedRelation: "threads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "thread_tags_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"threads": {
                  Row: {
                    "created_at": string,"id": string,"title": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"title": string,"updated_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"title"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "threads_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"topik_task_constructions": {
                  Row: {
                    "construction_id": number,"form": string | null,"task_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "construction_id": number,"form"?: string | null,"task_id": number
                  }
                  Update: {
                    "construction_id"?: number,"form"?: string | null,"task_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "topik_task_constructions_construction_id_fkey"
      columns: ["construction_id"]
isOneToOne: false
      referencedRelation: "constructions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "topik_task_constructions_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "topik_tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"topik_tasks": {
                  Row: {
                    "answer": number,"audio_path": string | null,"exam_id": number,"explanation": string | null,"id": number,"instruction": string,"number": number,"options": (string)[],"passage": string | null,"script": string | null,"section": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answer": number,"audio_path"?: string | null,"exam_id": number,"explanation"?: string | null,"id"?: never,"instruction": string,"number": number,"options": (string)[],"passage"?: string | null,"script"?: string | null,"section": string
                  }
                  Update: {
                    "answer"?: number,"audio_path"?: string | null,"exam_id"?: number,"explanation"?: string | null,"id"?: never,"instruction"?: string,"number"?: number,"options"?: (string)[],"passage"?: string | null,"script"?: string | null,"section"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "topik_tasks_exam_id_fkey"
      columns: ["exam_id"]
isOneToOne: false
      referencedRelation: "exams"
      referencedColumns: ["id"]
    }
                  ]
                },"usage": {
                  Row: {
                    "cost": number,"created_at": string,"id": number,"input_tokens": number | null,"kind": string,"model": string,"output_tokens": number | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cost"?: number,"created_at"?: string,"id"?: never,"input_tokens"?: number | null,"kind": string,"model": string,"output_tokens"?: number | null,"user_id": string
                  }
                  Update: {
                    "cost"?: number,"created_at"?: string,"id"?: never,"input_tokens"?: number | null,"kind"?: string,"model"?: string,"output_tokens"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "match_chunks":
{ Args: { "keywords"?: (string)[],"match_count"?: number,"query_embedding": string }; Returns: {
              "content": string,"id": number,"label": string,"lexical": boolean,"page": number,"similarity": number,"title": string
            }[]
                           },
"search_posts":
{ Args: { "match_count"?: number,"query": string,"query_embedding"?: string }; Returns: {
              "author": string,"body": string,"created_at": string,"exact": boolean,"post_id": string,"similarity": number,"thread_id": string,"thread_title": string
            }[]
                           }
          }
          Enums: {
            "level": "초급"|"중급"|"고급"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "level": ["초급", "중급", "고급"]
          }
        }
} as const
