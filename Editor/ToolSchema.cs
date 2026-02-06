using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Attribute to mark and describe tool parameters.
    /// Apply to fields of a parameters class to generate JSON Schema.
    /// </summary>
    [AttributeUsage(AttributeTargets.Field)]
    public class ToolParameterAttribute : Attribute
    {
        public string Description { get; set; }
        public bool Required { get; set; } = false;
        public object DefaultValue { get; set; }
        public double Min { get; set; } = double.NaN;
        public double Max { get; set; } = double.NaN;
        public string[] EnumValues { get; set; }

        public bool HasMin => !double.IsNaN(Min);
        public bool HasMax => !double.IsNaN(Max);

        public ToolParameterAttribute(string description)
        {
            Description = description;
        }
    }

    /// <summary>
    /// Represents a single property in a JSON Schema.
    /// </summary>
    [Serializable]
    public class SchemaProperty
    {
        public string type;
        public string description;
        public object @default;
        public double? minimum;
        public double? maximum;
        public string[] @enum;
    }

    /// <summary>
    /// JSON Schema for tool parameters, compatible with MCP protocol.
    /// </summary>
    [Serializable]
    public class ToolParameterSchema
    {
        public string type = "object";
        public Dictionary<string, SchemaProperty> properties = new Dictionary<string, SchemaProperty>();
        public List<string> required = new List<string>();

        /// <summary>
        /// Converts this schema to a JSON string.
        /// Uses custom serialization since Unity's JsonUtility doesn't handle dictionaries.
        /// </summary>
        public string ToJson()
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("{\"type\":\"object\",\"properties\":{");

            bool first = true;
            foreach (var kvp in properties)
            {
                if (!first) sb.Append(",");
                first = false;

                sb.Append("\"").Append(kvp.Key).Append("\":{");
                sb.Append("\"type\":\"").Append(kvp.Value.type).Append("\"");

                if (!string.IsNullOrEmpty(kvp.Value.description))
                {
                    sb.Append(",\"description\":\"").Append(EscapeJson(kvp.Value.description)).Append("\"");
                }

                if (kvp.Value.@default != null)
                {
                    sb.Append(",\"default\":").Append(SerializeValue(kvp.Value.@default));
                }

                if (kvp.Value.minimum.HasValue)
                {
                    sb.Append(",\"minimum\":").Append(kvp.Value.minimum.Value);
                }

                if (kvp.Value.maximum.HasValue)
                {
                    sb.Append(",\"maximum\":").Append(kvp.Value.maximum.Value);
                }

                if (kvp.Value.@enum != null && kvp.Value.@enum.Length > 0)
                {
                    sb.Append(",\"enum\":[");
                    for (int i = 0; i < kvp.Value.@enum.Length; i++)
                    {
                        if (i > 0) sb.Append(",");
                        sb.Append("\"").Append(EscapeJson(kvp.Value.@enum[i])).Append("\"");
                    }
                    sb.Append("]");
                }

                sb.Append("}");
            }

            sb.Append("}");

            if (required.Count > 0)
            {
                sb.Append(",\"required\":[");
                for (int i = 0; i < required.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append("\"").Append(required[i]).Append("\"");
                }
                sb.Append("]");
            }

            sb.Append("}");
            return sb.ToString();
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }

        private static string SerializeValue(object value)
        {
            if (value == null) return "null";
            if (value is bool b) return b ? "true" : "false";
            if (value is string s) return "\"" + EscapeJson(s) + "\"";
            if (value is int || value is long || value is float || value is double)
                return value.ToString();
            return "\"" + EscapeJson(value.ToString()) + "\"";
        }
    }

    /// <summary>
    /// Builder for creating ToolParameterSchema from a parameters type.
    /// </summary>
    public static class SchemaBuilder
    {
        /// <summary>
        /// Generate a ToolParameterSchema from a class type using reflection.
        /// Fields with [ToolParameter] attribute will be included in the schema.
        /// </summary>
        public static ToolParameterSchema FromType<T>() where T : class
        {
            return FromType(typeof(T));
        }

        /// <summary>
        /// Generate a ToolParameterSchema from a class type using reflection.
        /// </summary>
        public static ToolParameterSchema FromType(Type type)
        {
            var schema = new ToolParameterSchema();

            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                var attr = field.GetCustomAttribute<ToolParameterAttribute>();
                if (attr == null) continue;

                var prop = new SchemaProperty
                {
                    type = GetJsonType(field.FieldType),
                    description = attr.Description
                };

                if (attr.DefaultValue != null)
                {
                    prop.@default = attr.DefaultValue;
                }

                if (attr.HasMin)
                {
                    prop.minimum = attr.Min;
                }

                if (attr.HasMax)
                {
                    prop.maximum = attr.Max;
                }

                if (attr.EnumValues != null && attr.EnumValues.Length > 0)
                {
                    prop.@enum = attr.EnumValues;
                }

                // Convert field name to snake_case for JSON
                var jsonName = ToSnakeCase(field.Name);
                schema.properties[jsonName] = prop;

                if (attr.Required)
                {
                    schema.required.Add(jsonName);
                }
            }

            return schema;
        }

        /// <summary>
        /// Creates an empty schema for tools with no parameters.
        /// </summary>
        public static ToolParameterSchema Empty()
        {
            return new ToolParameterSchema();
        }

        private static string GetJsonType(Type type)
        {
            if (type == typeof(int) || type == typeof(long) || type == typeof(short) || type == typeof(byte))
                return "integer";
            if (type == typeof(float) || type == typeof(double) || type == typeof(decimal))
                return "number";
            if (type == typeof(bool))
                return "boolean";
            if (type == typeof(string))
                return "string";
            if (type.IsArray || (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>)))
                return "array";
            return "object";
        }

        private static string ToSnakeCase(string name)
        {
            if (string.IsNullOrEmpty(name)) return name;

            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                if (char.IsUpper(c))
                {
                    if (i > 0) sb.Append('_');
                    sb.Append(char.ToLowerInvariant(c));
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }
    }
}
